
from __future__ import annotations

import asyncio
import base64
import gc
import io
import os
import sys
import threading
import time
import uuid

from fastapi import FastAPI, Header, HTTPException
from PIL import Image, ImageChops
from pydantic import BaseModel

REGION = os.environ.get("SB_REGION", "ap-northeast-2")
BUCKET = os.environ["SB_BUCKET"]
POOL = os.environ["SB_POOL"]
CLIENT = os.environ["SB_CLIENT"]

MODELS = {
    "chroma": dict(
        repo="lodestones/Chroma1-Flash", label="Chroma1-Flash", note="빠름 · 연필 콘티",
        family="chroma", steps=12, guide=1.5, guide_ref=2.5, gb=26,
    ),
    "klein": dict(
        repo="black-forest-labs/FLUX.2-klein-4B", label="FLUX.2 klein 4B", note="균형 · 기준 반영",
        family="flux2", steps=8, guide=4.0, guide_ref=4.0, gb=15,
    ),
    "hd": dict(
        repo="lodestones/Chroma1-HD", label="Chroma1-HD", note="정밀 · 마감",
        family="chroma", steps=26, guide=4.0, guide_ref=4.0, gb=26,
    ),
    # 주의: SD 3.5 는 Apache-2.0 이 아니라 Stability Community License 다.
    # gated 저장소라서 HF 토큰이 있어야 내려온다. 토큰은 커넥터 화면에서 넣고
    # hf_token() 이 SSM 에서 읽는다. 없으면 이 모델만 못 올라가고 사유가 화면에 뜬다.
    "sd35": dict(
        repo="stabilityai/stable-diffusion-3.5-large", label="SD 3.5 Large", note="정밀 · SD 계열",
        family="sd3", steps=28, guide=3.5, guide_ref=3.5, gb=28, gated=True,
    ),
}
_env = os.environ.get("SB_MODEL", "chroma")
DEFAULT = _env if _env in MODELS else next(
    (k for k, v in MODELS.items() if v["repo"] == _env), "chroma")

STYLE = (
    "cinematic storyboard panel, expressive graphite pencil and ink wash on warm toned paper, "
    "confident linework, soft sepia monochrome, dramatic directional light"
)
NEG = (
    "text, letters, handwriting, speech bubble, caption, subtitle, watermark, signature, "
    "logo, border, frame, photograph, 3d render, blurry, washed out"
)
SHEET = "character design sheet, single character, plain background, full body visible, "
FINISH = (
    "finished storyboard panel drawn from this rough sketch, keep the same layout and camera, "
    "add full tonal shading, depth and atmosphere, "
)
KEEP = (
    "Using the reference image, draw the same character: identical face, hairstyle, build and "
    "clothing. Do not change the person. New shot: "
)
NOTEXT = "Do not write any text, labels or captions. "

SIZE = {"pose": (896, 1152), "cut": (1216, 688)}
MAX_STEPS = 40

app = FastAPI()

gpu = threading.Lock()
pipes: dict = {}
cur = None
loading = None
load_error = None

def _chroma(spec: dict) -> dict:
    import torch
    from diffusers import ChromaImg2ImgPipeline, ChromaPipeline

    p = ChromaPipeline.from_pretrained(spec["repo"], torch_dtype=torch.bfloat16).to("cuda")
    q = ChromaImg2ImgPipeline(**p.components)
    for x in (p, q):
        x.set_progress_bar_config(disable=True)
    return {"txt": p, "ref": q}

def _flux2(spec: dict) -> dict:
    import torch
    from diffusers import Flux2KleinPipeline

    p = Flux2KleinPipeline.from_pretrained(spec["repo"], torch_dtype=torch.bfloat16).to("cuda")
    p.set_progress_bar_config(disable=True)
    return {"txt": p, "ref": p}

def _sd3(spec: dict) -> dict:
    import torch
    from diffusers import StableDiffusion3Img2ImgPipeline, StableDiffusion3Pipeline

    p = StableDiffusion3Pipeline.from_pretrained(spec["repo"], torch_dtype=torch.bfloat16).to("cuda")
    q = StableDiffusion3Img2ImgPipeline(**p.components)
    for x in (p, q):
        x.set_progress_bar_config(disable=True)
    return {"txt": p, "ref": q}

FAMILY = {"chroma": _chroma, "flux2": _flux2, "sd3": _sd3}

# 커넥터가 SSM SecureString 에 넣어 둔 Hugging Face 키. 게이트된 저장소를 받을 때만 쓴다.
HF_PARAM = os.environ.get("SB_HF_PARAM", "/storyboard/connector/huggingface")
_hf: str | None = None

def hf_token() -> str:
    """부팅 때 한 번 읽지 않는다. 커넥터로 키를 나중에 넣거나 갈아도 재부팅 없이 먹어야 한다."""
    global _hf
    if _hf is None:
        try:
            import json

            import boto3

            raw = boto3.client("ssm", region_name=REGION).get_parameter(
                Name=HF_PARAM, WithDecryption=True)["Parameter"]["Value"]
            # 커넥터는 JSON({"key": …})으로 적는다. 손으로 넣은 평문 토큰도 그대로 받는다
            _hf = (json.loads(raw).get("key", "") if raw.lstrip().startswith("{") else raw).strip()
        except Exception:
            _hf = ""
    return _hf

def _unload() -> None:
    global pipes, cur
    import torch

    for p in set(pipes.values()):
        try:
            p.remove_all_hooks()
        except Exception:
            pass
    pipes, cur = {}, None
    for _ in range(2):
        gc.collect()
    torch.cuda.empty_cache()

def _load(mid: str) -> None:
    global cur, loading, load_error, pipes
    if cur == mid:
        loading = None
        return
    global _hf
    try:
        if MODELS[mid].get("gated"):
            tok = hf_token()
            if not tok:
                load_error = f"{mid}: Hugging Face 키가 없습니다. 커넥터에서 키를 넣어주세요"
                return
            os.environ["HF_TOKEN"] = tok
        _unload()
        pipes = FAMILY[MODELS[mid]["family"]](MODELS[mid])
        cur, load_error = mid, None
    except Exception as e:
        load_error = f"{mid}: {type(e).__name__}: {e}"
        _hf = None  # 키를 갈아 끼웠을 수 있다. 다음 시도에서 SSM 을 다시 읽는다
    finally:
        if loading == mid:
            loading = None

def _kick(mid: str) -> None:

    global loading
    if cur == mid or loading == mid:
        return
    loading = mid
    threading.Thread(target=lambda: _load_locked(mid), daemon=True).start()

def _load_locked(mid: str) -> None:
    with gpu:
        _load(mid)

DISK_MBS = 300

def wait_s(mid: str) -> int:
    return round(MODELS[mid]["gb"] * 1024 / DISK_MBS)

def decode(data: str) -> Image.Image:
    raw = data.split(",", 1)[1] if data.startswith("data:") else data
    return Image.open(io.BytesIO(base64.b64decode(raw)))

def clamp(x: float, lo: float = 0.2, hi: float = 0.95) -> float:
    return max(lo, min(hi, float(x)))

def lamp(im: Image.Image, floor: float = 0.22) -> Image.Image:
    ramp = Image.linear_gradient("L").rotate(90, expand=True).resize(im.size)
    ch = lambda a, b: ramp.point(lambda v: int(a + (b - a) * v / 255))
    warm = Image.merge("RGB", (ch(floor * 293, 255), ch(floor * 255, 246), ch(floor * 204, 228)))
    return ImageChops.multiply(im, warm)

_en: dict[str, str] = {}

# 손으로 한국어를 적은 프롬프트만 영어로 옮긴다. 옮기는 것도 Bedrock 이 한다.
# 프롬프트를 쓰는 것이 이미 Bedrock 이라, 이 서버가 부르는 모델 서비스는 하나뿐이다.
# 리전(ap-northeast-2)에 In-Region 이 없어 전역 추론 프로필을 쓴다. infra/graph/index.js 와 같다.
EN_MODEL = os.environ.get("SB_EN_MODEL", "global.anthropic.claude-haiku-4-5-20251001-v1:0")
EN_SYSTEM = (
    "Translate the text into English for an image generation prompt. "
    "Reply with the translation only: no quotes, no notes, no extra words."
)

def en(text: str) -> str:

    text = (text or "").strip()
    if not text or text.isascii():
        return text
    if text not in _en:
        try:
            import boto3
            from botocore.config import Config

            # 짧게 끊는다. 이 호출이 매달리면 그림이 한 장도 안 나온다. 못 옮기면 원문으로 간다
            out = boto3.client(
                "bedrock-runtime", region_name=REGION,
                config=Config(connect_timeout=4, read_timeout=20, retries={"max_attempts": 2}),
            ).converse(
                modelId=EN_MODEL,
                system=[{"text": EN_SYSTEM}],
                messages=[{"role": "user", "content": [{"text": text[:900]}]}],
                inferenceConfig={"maxTokens": 512, "temperature": 0},
                additionalModelRequestFields={"thinking": {"type": "disabled"}},
            )
            said = "".join(c.get("text", "") for c in out["output"]["message"]["content"]).strip()
            # 빈 답이 오면 원문을 그대로 둔다. 그림이 안 나오는 것보다 낫다
            _en[text] = said or text
        except Exception:
            _en[text] = text
    return _en[text]

ART_ROLES = {"artist", "planner"}

def who(authorization: str | None, need_art: bool = False) -> str:

    if not authorization:
        raise HTTPException(401, "로그인이 필요합니다")
    token = authorization[7:] if authorization.startswith("Bearer ") else authorization
    try:
        import jwt

        global _jwks
        if _jwks is None:
            _jwks = jwt.PyJWKClient(
                f"https://cognito-idp.{REGION}.amazonaws.com/{POOL}/.well-known/jwks.json"
            )
        claims = jwt.decode(
            token,
            _jwks.get_signing_key_from_jwt(token).key,
            algorithms=["RS256"],
            audience=CLIENT,
            issuer=f"https://cognito-idp.{REGION}.amazonaws.com/{POOL}",
        )
    except Exception as e:
        raise HTTPException(401, f"토큰을 확인할 수 없습니다 ({type(e).__name__})") from e
    if claims.get("token_use") != "id":
        raise HTTPException(401, "ID 토큰이 필요합니다")
    if need_art and (claims.get("custom:role") or "reviewer") not in ART_ROLES:
        raise HTTPException(403, "그림 만들기는 아티스트와 기획만 할 수 있습니다")
    return claims.get("cognito:username") or claims["sub"]

_jwks = None

class Req(BaseModel):
    prompt: str = ""
    kind: str = "cut"
    model: str | None = None
    seed: int | None = None
    init: str | None = None
    strength: float = 0.85
    steps: int | None = None
    guidance: float | None = None

def pick(mid: str | None) -> str:
    return mid if mid in MODELS else (cur or DEFAULT)

def build(spec: dict, req: Req) -> str:
    body = en(req.prompt)[:400]
    head = SHEET if req.kind == "pose" else ""
    pre = NOTEXT if spec["family"] == "flux2" else ""
    if not req.init:
        return f"{pre}{head}{body}. {STYLE}"
    if spec["family"] in ("chroma", "sd3"):
        return f"{head}{FINISH}{body}. {STYLE}"
    return f"{pre}{KEEP}{head}{body}. {STYLE}"

def args_for(spec: dict, prompt: str, w: int, h: int, steps: int, guide: float,
             g, ref: Image.Image | None, strength: float) -> dict:
    fam = spec["family"]
    a = dict(prompt=prompt, num_inference_steps=steps, width=w, height=h, generator=g)
    if fam in ("chroma", "sd3"):
        a.update(negative_prompt=NEG, guidance_scale=guide)
        if ref is not None:
            a.update(image=lamp(ref.resize((w, h), Image.LANCZOS)), strength=clamp(strength))
    else:
        a["guidance_scale"] = guide
        if ref is not None:
            a["image"] = [ref]
    return a

def run(req: Req, seed: int) -> Image.Image:
    import torch

    mid = pick(req.model)
    spec = MODELS[mid]
    w, h = SIZE.get(req.kind, SIZE["cut"])
    ref = decode(req.init).convert("RGB") if req.init else None
    steps = min(int(req.steps or spec["steps"]), MAX_STEPS)
    guide = float(req.guidance or (spec["guide_ref"] if ref is not None else spec["guide"]))
    # 프롬프트를 잠금 밖에서 먼저 만든다. 한국어면 build 안에서 Bedrock 을 부르는데,
    # 그 네트워크 대기를 잠금 안에서 하면 그 시간만큼 팀 전원의 생성이 밀린다
    prompt = build(spec, req)
    with gpu:
        if cur != mid:
            raise HTTPException(503, f"{spec['label']}을 올리는 중입니다. 잠시 뒤 다시 눌러주세요.")
        g = torch.Generator("cuda").manual_seed(seed)
        a = args_for(spec, prompt, w, h, steps, guide, g, ref, req.strength)
        return pipes["ref" if ref is not None else "txt"](**a).images[0]

@app.post("/gen")
async def gen(req: Req, authorization: str | None = Header(None)):
    who(authorization, need_art=True)
    mid = pick(req.model)
    if cur != mid:
        _kick(mid)
        raise HTTPException(503, load_error or
                            f"{MODELS[mid]['label']}을 올리는 중입니다"
                            f"(약 {max(1, round(wait_s(mid) / 60))}분). 준비되면 다시 눌러주세요.")

    t = time.time()
    seed = req.seed if req.seed is not None else int.from_bytes(os.urandom(2), "big")
    img = await asyncio.to_thread(run, req, seed)

    import boto3

    key = f"img/{uuid.uuid4().hex}.png"
    buf = io.BytesIO()
    img.save(buf, "PNG", optimize=True)
    boto3.client("s3", region_name=REGION).put_object(
        Bucket=BUCKET, Key=key, Body=buf.getvalue(), ContentType="image/png",
        CacheControl="public, max-age=31536000, immutable",
    )
    return {
        "url": f"/{key}", "seed": seed,
        "model": MODELS[mid]["label"], "modelId": mid,
        "ms": int((time.time() - t) * 1000),
        "size": SIZE.get(req.kind, SIZE["cut"]),
    }

@app.post("/gen/load")
async def load(req: Req, authorization: str | None = Header(None)):
    who(authorization, need_art=True)
    mid = pick(req.model)
    _kick(mid)
    return {"ok": True, "modelId": mid, "resident": cur, "loading": loading, "wait": wait_s(mid)}

@app.get("/gen/health")
def health():
    name = None
    try:
        import torch

        name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        pass
    return {
        "ok": True, "warm": cur is not None, "busy": gpu.locked(),
        "model": MODELS[cur]["label"] if cur else None, "modelId": cur,
        "loading": loading, "wait": wait_s(loading) if loading else 0,
        "models": [{"id": k, "label": v["label"], "note": v["note"], "wait": wait_s(k),
                    "strength": v["family"] in ("chroma", "sd3")} for k, v in MODELS.items()],
        "gpu": name, "error": load_error,
    }

if __name__ != "__main__":
    _kick(DEFAULT)

if __name__ == "__main__":
    px = Image.new("RGB", (4, 4), "white")
    b = io.BytesIO()
    px.save(b, "PNG")
    url = "data:image/png;base64," + base64.b64encode(b.getvalue()).decode()
    assert decode(url).size == (4, 4)
    assert decode(url.split(",", 1)[1]).size == (4, 4)
    assert clamp(9) == 0.95 and clamp(0) == 0.2 and clamp(0.5) == 0.5
    assert en("hello") == "hello" and en("") == ""
    assert SIZE["pose"][0] % 16 == 0 and SIZE["cut"][1] % 16 == 0
    assert "watermark" not in STYLE and "watermark" in NEG
    sk = Image.new("RGB", (64, 32), "white")
    lit = lamp(sk)
    assert lit.size == sk.size
    assert lit.getpixel((2, 16))[0] < lit.getpixel((61, 16))[0] < 256
    assert sum(lit.getpixel((2, 16))) < 3 * 255 * 0.4

    assert set(MODELS) == {"chroma", "klein", "hd", "sd35"}
    assert MODELS["sd35"]["gated"] and not any(v.get("gated") for k, v in MODELS.items() if k != "sd35")
    for k, v in MODELS.items():
        assert v["family"] in FAMILY, k
        assert all(v.get(f) for f in ("repo", "label", "note", "steps", "guide", "guide_ref", "gb"))
    assert pick(None) == DEFAULT and pick("없는모델") == DEFAULT and pick("hd") == "hd"
    cur = "klein"
    assert pick(None) == "klein" and pick("hd") == "hd"
    cur = None
    assert wait_s("klein") < wait_s("hd")

    assert min(int(Req(steps=9999).steps or 0), MAX_STEPS) == MAX_STEPS
    assert min(int(Req().steps or MODELS["chroma"]["steps"]), MAX_STEPS) == 12

    r = Req(prompt="a baker", init="x", kind="cut")
    for k in ("chroma", "hd", "sd35"):
        assert FINISH in build(MODELS[k], r) and KEEP not in build(MODELS[k], r)
    assert KEEP in build(MODELS["klein"], r) and FINISH not in build(MODELS["klein"], r)
    assert SHEET in build(MODELS["klein"], Req(prompt="x", kind="pose"))
    assert NOTEXT in build(MODELS["klein"], Req(prompt="x"))
    assert NOTEXT in build(MODELS["klein"], r)
    assert all(NOTEXT not in build(MODELS[k], r) for k in ("chroma", "hd", "sd35"))
    assert all(KEEP not in build(v, Req(prompt="x")) and FINISH not in build(v, Req(prompt="x"))
               for v in MODELS.values())

    ref = Image.new("RGB", (32, 32), "white")
    ac = args_for(MODELS["chroma"], "p", 64, 32, 12, 2.5, None, ref, 0.85)
    ah = args_for(MODELS["hd"], "p", 64, 32, 26, 4.0, None, ref, 0.85)
    ak = args_for(MODELS["klein"], "p", 64, 32, 8, 4.0, None, ref, 0.85)
    assert ac["strength"] == 0.85 and ac["image"].size == (64, 32)
    assert ah["strength"] == 0.85 and ah["negative_prompt"] == NEG
    ax = args_for(MODELS["sd35"], "p", 64, 32, 28, 3.5, None, ref, 0.85)
    assert ax["strength"] == 0.85 and ax["negative_prompt"] == NEG
    assert "strength" not in ak
    assert ak["image"] == [ref]
    assert "negative_prompt" not in ak and ak["guidance_scale"] == 4.0
    assert "image" not in args_for(MODELS["klein"], "p", 64, 32, 8, 4.0, None, None, 0.85)
    print("ok")

    if "prefetch" in sys.argv:
        from diffusers import DiffusionPipeline

        tok = hf_token()
        if tok:
            os.environ["HF_TOKEN"] = tok
        for k, v in MODELS.items():
            if v.get("gated") and not tok:
                print(f"건너뜀 {k} — Hugging Face 키가 없다 (커넥터에서 넣으면 그때 받는다)", flush=True)
                continue
            print(f"내려받기 {k} {v['repo']} 약 {v['gb']}GB", flush=True)
            try:
                DiffusionPipeline.download(v["repo"])
            except Exception as e:
                print(f"  실패 {type(e).__name__}: {e}", flush=True)
