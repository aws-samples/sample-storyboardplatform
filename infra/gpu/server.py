
from __future__ import annotations

import asyncio
import base64
import gc
import io
import os
import re
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
    # Krea 2 Turbo. 8걸음 증류판이라 빠르고 글자·손이 덜 깨진다. 텍스트→그림만이다 —
    # diffusers 의 Krea2Pipeline 은 그림을 조건으로 받지 않는다(init 도 refs 도 무시). 참조가
    # 있는 요청은 화면이 klein 으로 돌려 보낸다(board.js 의 refModelId). 게이트 저장소라
    # HF 토큰 계정이 약관에 동의해 두어야 내려온다. Qwen3-VL-4B 인코더 9GB + 트랜스포머 26GB.
    "krea": dict(
        repo="krea/Krea-2-Turbo", label="Krea 2 Turbo", note="빠름 · 사실적",
        family="krea", steps=8, guide=0.0, guide_ref=0.0, gb=36, gated=True, init=False,
    ),
    # 영상 모델. 그림 모델과 같은 자리(GPU 하나)를 쓰므로 올라오면 그림 모델은 내려간다.
    # Apache-2.0 이고 게이트도 없다. 5B 라 34GB 로 이 디스크에 들어가는 유일한 I2V 모델이다.
    "wan": dict(
        repo="Wan-AI/Wan2.2-TI2V-5B-Diffusers", label="Wan2.2 TI2V 5B", note="컷을 영상으로",
        family="wan", steps=20, guide=5.0, guide_ref=5.0, gb=34, video=True,
    ),
}
VIDEO = {k for k, v in MODELS.items() if v.get("video")}
# 기본 그림 모델. 부팅 때 이것을 올리고, 화면이 모델을 고르지 않으면 여기로 돌아온다.
# klein 인 이유: 기준 이미지를 조건(reference)으로 받는 계열이 이 빌드에서 flux2 하나뿐이다.
# 만든 얼굴을 그대로 살리는 일과 얼굴 두 장을 붙인 시트로 두 인물 장면을 그리는 일은
# img2img 로는 안 된다(args_for 참고). 게이트도 없어서 HF 토큰 없이 올라간다.
FALLBACK = "krea"
_env = os.environ.get("SB_MODEL", FALLBACK)
DEFAULT = _env if _env in MODELS else next(
    (k for k, v in MODELS.items() if v["repo"] == _env), FALLBACK)

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
# 얼굴 여러 장을 한 장으로 붙인 시트(화면의 faceSheet)를 받았을 때. KEEP 은 「the person」
# 한 사람을 말하므로 그 말로는 둘 중 하나만 그린다
CAST = (
    "The reference image is a sheet of separate character portraits placed side by side. Draw all "
    "of these characters together in one new scene, keeping each face, hairstyle, build and "
    "clothing as shown. Do not copy the sheet layout. New shot: "
)
# 씬 키 비주얼처럼 「같은 룩」만 물려받는 자리. 구도까지 물려받으면 컷이 다 같아진다
LOOK = (
    "Match the palette, light and atmosphere of the reference image, but draw a different shot. "
    "Do not copy its layout or camera. New shot: "
)
NOTEXT = "Do not write any text, labels or captions. "
# 실사 스틸(자산관리 화면). 콘티는 연필이지만 스틸은 VFX·영상 기획이 룩을 잡는 한 장이라
# 사실적인 사진 룩으로 간다. 참조 자산(연필 그림)에서 얼굴·장소·물건만 물려받고 질감은 버린다
STYLE_REAL = (
    "photorealistic cinematic film still, natural physically based lighting, real skin and "
    "fabric texture, shallow depth of field, 35mm lens, color graded, ultra detailed"
)
NEG_REAL = (
    NEG.replace("photograph, ", "") + ", illustration, drawing, sketch, pencil, ink, monochrome, "
    "sepia, painting, cartoon, anime, paper texture"
)
# 승인된 컷 한 장에서 자산을 떼어 내는 자리(화면의 extractAssets). 열쇠는 domain/panels.js 의
# assetJobs 가 refKind 로 보내는 값과 같다. 그 컷의 「이 사람만 · 사람 없는 이 장소만 · 이
# 물건만」을 새로 그리게 한다 — 잘라 내는 것이 아니라 다시 그리는 것이라 배경에서 사람이
# 빠지고 상품이 홀로 선다
ISOLATE = {
    "asset_char": (
        "From the reference image, draw only this one character, described below. Keep the "
        "identical face, hairstyle, build and clothing. Full body, relaxed standing pose facing "
        "the viewer, alone on a plain empty background. No scenery, no other people, no props. "
    ),
    "asset_bg": (
        "From the reference image, draw the same location as an empty establishing shot: same "
        "place, architecture, furniture, light and atmosphere, seen from a similar angle. "
        "Remove every person and character. No people, no faces, no foreground props. "
    ),
    "asset_prop": (
        "From the reference image, draw only the single most important product or prop object "
        "shown in it, centered and large, alone on a plain empty background. No people, no "
        "hands, no scenery. "
    ),
}
# 자산 여러 장을 참조로 받아 새 컷을 그리는 자리. refs 가 둘 이상일 때 화면이 이걸 보낸다
ASSETS = (
    "The reference images are separate assets: characters, a location and props. Compose them "
    "into one new shot, keeping each character's face, hairstyle, build and clothing, the "
    "location's architecture and light, and each product exactly as shown. Do not copy the "
    "layout of any reference. New shot: "
)

# still 은 실사 스틸. 확대해 보는 그림이라 컷의 두 배 남짓이다. klein 4B 가 L40S 에서 8걸음에
# 20초 안팎이고, CloudFront 의 /gen 60초 안에 들어온다(실측은 pages/assets.js 머리글)
SIZE = {"pose": (896, 1152), "cut": (1216, 688), "asset": (1024, 1024), "still": (1920, 1088)}
MAX_STEPS = 40

# 영상. 컷 그림을 첫 프레임으로 두고 몇 초를 움직인다.
MOTION = (
    "storyboard animatic, keep the drawing style and composition, subtle believable motion, "
    "steady camera, no cuts, no new characters entering"
)
VNEG = (
    "text, letters, caption, watermark, logo, sudden cut, scene change, camera shake, "
    "distorted anatomy, extra limbs, flicker, morphing background"
)
FPS = 24
# 화질 두 칸. 걸음 수는 같고 넓이만 다르다 — 20 걸음이면 충분하고, 시간은 거의 넓이에
# 비례해서 늘어난다. L40S 실측(49프레임=2초, 121프레임=5초):
#   832x480   49f 29초 / 121f 88초    (peak 27.0GB)
#   1280x704  49f 80초 / 121f 226초   (peak 30.5GB)
VQ = {
    "fast": dict(area=832 * 480, steps=20, label="빠르게 · 832×480"),
    "fine": dict(area=1280 * 704, steps=20, label="곱게 · 1280×704"),
}
VSECS = (2, 3, 5)
# 만든 영상 1초당 대략 이만큼 걸린다. 화면이 남은 시간을 보여주는 데만 쓴다. 위 실측보다
# 조금 넉넉하게 잡는다 — 남은 시간이 0 이 된 뒤에도 도는 편이 더 나쁘게 읽힌다
EST = {"fast": 18, "fine": 46}
JOBS: dict[str, dict] = {}
JOB_KEEP = 24
# 이만큼 지난 일감은 죽은 것으로 본다. 제일 무거운 조합(5초 · 곱게)도 4분 안에 끝난다
JOB_MAX_S = 900

def vid_pending() -> bool:
    """
    받아 둔 영상 일감이 아직 도는 중인가. 이 동안 모델을 갈면 그 일감이 죽는다.

    이것이 /gen · /gen/load · /gen/animate 를 함께 막으므로, 끝난 표시를 못 받은 일감이
    하나라도 남으면 이 기계의 그림 생성까지 영원히 503 이 된다. 그래서 너무 오래된 것은
    여기서 끝난 것으로 적어 준다 — 도는 실이 이미 죽어 아무도 적어 주지 않는 경우다
    """
    live = False
    for x in JOBS.values():
        if x["status"] not in ("wait", "run"):
            continue
        if time.time() - x["ts"] > JOB_MAX_S:
            x.update(status="error", error="영상을 만들다 너무 오래 걸려 끊긴 것으로 봅니다.")
            continue
        live = True
    return live

app = FastAPI()

gpu = threading.Lock()
pipes: dict = {}
cur = None
loading = None
# 모델을 올리다 엎어진 마지막 사유와, 그것이 어느 모델의 것인가. 모델 이름을 함께 들고
# 있지 않으면 영상 모델이 실패한 사유를 그림을 기다리는 화면이 자기 것으로 읽는다 —
# 「sd35: Hugging Face 키가 없습니다」를 영상 만들다 보게 되면 상관없는 키를 넣으러 간다
load_error = None
load_error_mid = None

def err_for(mid: str) -> str | None:
    """이 모델을 올리다 엎어진 사유. 다른 모델의 사유는 이 자리에서 거짓말이 된다"""
    return load_error if load_error_mid == mid else None

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

def _krea(spec: dict) -> dict:
    import torch
    from diffusers import Krea2Pipeline

    p = Krea2Pipeline.from_pretrained(spec["repo"], torch_dtype=torch.bfloat16, token=hf_token() or None).to("cuda")
    p.set_progress_bar_config(disable=True)
    # 그림을 받는 갈래가 없다. 참조가 와도 같은 파이프로 글만 보고 그린다(args_for 가 image 를 안 넣는다)
    return {"txt": p, "ref": p}

def _wan(spec: dict) -> dict:
    import torch
    from diffusers import AutoencoderKLWan, WanImageToVideoPipeline

    # VAE 만 float32 다. bfloat16 으로 두면 프레임에 색 얼룩이 남는다(Wan 문서 권장)
    vae = AutoencoderKLWan.from_pretrained(spec["repo"], subfolder="vae", torch_dtype=torch.float32)
    p = WanImageToVideoPipeline.from_pretrained(
        spec["repo"], vae=vae, torch_dtype=torch.bfloat16).to("cuda")
    p.set_progress_bar_config(disable=True)
    # 프레임을 풀 때가 제일 무겁다. 타일로 나눠 풀지 않으면 46GB 카드에서도
    # 1280x704 는 VAE 에서 OutOfMemory 로 죽는다(실측)
    p.vae.enable_tiling()
    return {"vid": p}

FAMILY = {"chroma": _chroma, "flux2": _flux2, "sd3": _sd3, "krea": _krea, "wan": _wan}

# 커넥터가 SSM SecureString 에 넣어 둔 Hugging Face 키. 게이트된 저장소를 받을 때만 쓴다.
HF_PARAM = os.environ.get("SB_HF_PARAM", "/storyboard/connector/huggingface")
_hf: str | None = None

def hf_token() -> str:
    """부팅 때 한 번 읽지 않는다. 커넥터로 키를 나중에 넣거나 갈아도 재부팅 없이 먹어야 한다."""
    global _hf
    if _hf is not None:
        return _hf
    tok = ""
    try:
        import json

        import boto3

        raw = boto3.client("ssm", region_name=REGION).get_parameter(
            Name=HF_PARAM, WithDecryption=True)["Parameter"]["Value"]
        # 커넥터는 JSON({"key": …})으로 적는다. 손으로 넣은 평문 토큰도 그대로 받는다
        tok = (json.loads(raw).get("key", "") if raw.lstrip().startswith("{") else raw).strip()
    except Exception:
        tok = ""
    # 빈 값은 굳히지 않는다. 굳히면 커넥터에서 키를 넣어도 재시작 전까지 게이트 모델이 영원히 안 올라온다
    _hf = tok or None
    return tok

def _unload() -> None:
    """
    올려 둔 모델을 GPU 에서 실제로 내린다.

    pipes 를 비우는 것만으로는 부족하다. 파이프 객체를 잡고 있는 자리가 하나라도 남으면
    (터진 요청의 traceback, 돌고 있는 영상 일감) 안의 무게(transformer·VAE·텍스트 인코더)가
    그대로 카드에 남는다. 실제로 그렇게 남아서, 다음 모델을 올린 뒤 44.3GB/44.4GB 로
    「CUDA out of memory」가 났다. 그러니 파이프가 들고 있는 모듈 참조를 하나씩 끊는다 —
    파이프가 남아 있어도 무게는 풀린다.
    """
    global pipes, cur
    import torch

    old, (pipes, cur) = list(pipes.values()), ({}, None)
    for p in old:
        try:
            p.remove_all_hooks()
        except Exception:
            pass
        for name in list(getattr(p, "components", None) or {}):
            try:
                setattr(p, name, None)
            except Exception:
                pass
    old.clear()
    for _ in range(2):
        gc.collect()
    torch.cuda.empty_cache()
    torch.cuda.ipc_collect()
    left = torch.cuda.memory_allocated() / 2**30
    if left > 1:
        print(f"[unload] GPU 에 {left:.1f}GB 가 남았습니다", flush=True)

def _load(mid: str) -> None:
    global cur, loading, load_error, load_error_mid, pipes
    if cur == mid:
        # 내가 세운 표시만 내린다. 그냥 None 으로 두면, 다른 모델을 올리려고 잠금 앞에
        # 줄 서 있는 _kick 의 표시까지 지워져 health 가 「올리는 중」을 잃는다
        if loading == mid:
            loading = None
        return
    global _hf
    # 새로 올리기 시작하면 지난 실패는 잊는다. 남겨 두면 이번 시도가 도는 중에도 화면이
    # 지난 사유를 읽고, 503 을 「키가 없다」로 잘못 말한다
    load_error, load_error_mid = None, None
    try:
        if MODELS[mid].get("gated"):
            tok = hf_token()
            if not tok:
                load_error = f"{mid}: Hugging Face 키가 없습니다. 커넥터에서 키를 넣어주세요"
                load_error_mid = mid
                return
            os.environ["HF_TOKEN"] = tok
        _unload()
        pipes = FAMILY[MODELS[mid]["family"]](MODELS[mid])
        cur, load_error, load_error_mid = mid, None, None
    except Exception as e:
        load_error, load_error_mid = f"{mid}: {type(e).__name__}: {e}", mid
        _hf = None  # 키를 갈아 끼웠을 수 있다. 다음 시도에서 SSM 을 다시 읽는다
    finally:
        if loading == mid:
            loading = None

def _kick(mid: str, force: bool = False) -> None:
    """
    모델을 올리기 시작한다. 한 번 엎어진 모델(err_for)은 저절로 다시 올리지 않는다 — /gen 이 올
    때마다 다시 올리면 그때마다 지금 올라와 있는 모델을 먼저 내려서(_unload) 되는 모델까지
    죽인다. 사람이 모델 칩을 눌러 /gen/load 로 다시 고르면(force) 그때 다시 해 본다.
    """
    global loading
    if cur == mid or loading == mid:
        return
    if not force and err_for(mid):
        return
    loading = mid
    threading.Thread(target=lambda: _load_locked(mid), daemon=True).start()

def _load_locked(mid: str) -> None:
    with gpu:
        _load(mid)

DISK_MBS = 300

def wait_s(mid: str) -> int:
    return round(MODELS[mid]["gb"] * 1024 / DISK_MBS)

def seed_of(s: int | None) -> int:
    """씨앗은 32비트 안이어야 한다. 밖에서 온 큰 수를 그대로 넘기면 torch 가 터진다"""
    return int(s) % 2**32 if s is not None else int.from_bytes(os.urandom(2), "big")

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
# 자산 뽑기(refKind asset_*)는 승인을 누른 사람의 브라우저가 바로 부른다. 승인은 감독의
# 일이라(domain/panels.js 의 ACTIONS.approve) 감독·관리자도 든다. domain/permissions.js 의
# extract 와 같아야 한다 — test.html 이 두 줄을 맞대어 본다
ASSET_ROLES = {"artist", "planner", "director", "admin"}

def who(authorization: str | None, need_art: bool = False, roles: set = ART_ROLES) -> str:

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
    if need_art and (claims.get("custom:role") or "reviewer") not in roles:
        raise HTTPException(403, "자산 뽑기는 아티스트·기획·감독만 할 수 있습니다" if roles is ASSET_ROLES
                            else "그림 만들기는 아티스트와 기획만 할 수 있습니다")
    return claims.get("cognito:username") or claims["sub"]

_jwks = None

class Req(BaseModel):
    prompt: str = ""
    kind: str = "cut"
    model: str | None = None
    seed: int | None = None
    init: str | None = None
    # 참조 그림 여러 장(자산). klein 은 그림 목록을 조건으로 받는다. init 과 같이 오면 refs 가
    # 앞이고 init 은 뒤에 붙는다. img2img 갈래(chroma·sd3)는 한 장만 받으므로 첫 장을 쓴다
    refs: list[str] | None = None
    # 기반 이미지가 무엇인가 — sketch(올린 스케치) · face(인물 얼굴 한 장) · cast(얼굴 시트)
    # · image(키비주얼 등 그림 한 장). 모양이 같은 한 칸(init)으로 들어오기 때문에 화면이
    # 말해 주지 않으면 서버가 구별할 수 없고, 그러면 스케치에게 「인물을 그대로 두라」고
    # 하거나 얼굴에게 「같은 구도를 유지하라」고 하게 된다
    refKind: str | None = None
    # 룩. 기본은 연필 콘티(STYLE), "real" 이면 실사 스틸(STYLE_REAL)
    style: str | None = None
    strength: float = 0.85
    steps: int | None = None
    guidance: float | None = None

def pick(mid: str | None) -> str:
    """그림 모델만 고른다. 영상 모델이 올라와 있어도 /gen 은 그림 모델로 되돌아간다"""
    if mid in MODELS and mid not in VIDEO:
        return mid
    return cur if cur and cur not in VIDEO else DEFAULT

# 참조 그림을 조건으로 받는 모델. 그림을 받지 않는 모델(krea)에 참조가 오면 여기로 돌린다
REF_MODEL = next(k for k, v in MODELS.items() if v["family"] == "flux2")

def pick_for(req: Req) -> str:
    """요청에 맞는 그림 모델. 참조(refs·init)가 있는데 고른 모델이 그림을 받지 않으면 REF_MODEL.
    화면(board.js 의 modelFor)도 같은 판단을 하지만, 서버가 보장해야 참조를 말없이 버리는 일이 없다"""
    mid = pick(req.model)
    if (req.refs or req.init) and MODELS[mid].get("init") is False:
        return REF_MODEL
    return mid

def build(spec: dict, req: Req) -> str:
    """
    지시문 한 줄. 기반 이미지가 무엇인지(refKind)에 따라 앞에 붙는 말이 달라진다.

    모델 갈래로 갈라서는 안 된다. 갈래는 「어떻게 넣는가」(img2img 인가 조건인가)이고,
    여기서 필요한 것은 「무엇을 넣었는가」다. 갈래로 갈랐을 때 스케치를 얹은 flux2 는
    「인물을 바꾸지 마라」를 받았고, 얼굴을 얹은 sd3 는 「같은 구도를 유지하라」를 받았다.

    refKind 를 안 보내는 옛 화면은 예전 그대로 둔다(chroma·sd3 는 스케치, flux2 는 얼굴).
    """
    body = en(req.prompt)[:400]
    head = SHEET if req.kind == "pose" else ""
    pre = NOTEXT if spec["family"] in ("flux2", "krea") else ""
    style = STYLE_REAL if real(req) else STYLE
    # 그림을 받지 않는 갈래(krea)는 참조가 와도 「참조를 보고」로 시작하면 안 된다 — 볼 그림이 없다
    if not (req.init or req.refs) or spec.get("init") is False:
        return f"{pre}{head}{body}. {style}"
    kind = req.refKind or ("sketch" if spec["family"] in ("chroma", "sd3") else "face")
    lead = {"sketch": FINISH, "face": KEEP, "cast": CAST, "assets": ASSETS, **ISOLATE}.get(kind, LOOK)
    return f"{pre}{lead}{head}{body}. {style}"

def real(req: Req) -> bool:
    return str(req.style or "") == "real"

def args_for(spec: dict, prompt: str, w: int, h: int, steps: int, guide: float,
             g, refs: list, strength: float, neg: str = NEG) -> dict:
    """refs 는 참조 그림 목록(없으면 빈 목록). klein 은 전부 조건으로, img2img 갈래는 첫 장만"""
    fam = spec["family"]
    a = dict(prompt=prompt, num_inference_steps=steps, width=w, height=h, generator=g)
    if fam in ("chroma", "sd3"):
        a.update(negative_prompt=neg, guidance_scale=guide)
        if refs:
            a.update(image=lamp(refs[0].resize((w, h), Image.LANCZOS)), strength=clamp(strength))
    elif fam == "krea":
        # 그림을 받지 않는다. 증류판은 guidance 0 이라 negative 는 뜻이 없지만 파이프가 받으니 넘긴다
        a.update(negative_prompt=neg, guidance_scale=guide)
    else:
        a["guidance_scale"] = guide
        if refs:
            a["image"] = list(refs)
    return a

MAX_REFS = 6

def refs_of(req: Req) -> list:
    """요청의 참조 그림들. refs 가 앞, init 이 뒤. 너무 많으면 앞에서 자른다 — 카드가 터진다"""
    out = [decode(x).convert("RGB") for x in (req.refs or []) if x]
    if req.init:
        out.append(decode(req.init).convert("RGB"))
    return out[:MAX_REFS]

def run(req: Req, seed: int) -> Image.Image:
    import torch

    mid = pick(req.model)
    spec = MODELS[mid]
    w, h = SIZE.get(req.kind, SIZE["cut"])
    refs = refs_of(req)
    steps = max(1, min(int(req.steps or spec["steps"]), MAX_STEPS))
    guide = float(req.guidance or (spec["guide_ref"] if refs else spec["guide"]))
    # 프롬프트를 잠금 밖에서 먼저 만든다. 한국어면 build 안에서 Bedrock 을 부르는데,
    # 그 네트워크 대기를 잠금 안에서 하면 그 시간만큼 팀 전원의 생성이 밀린다
    prompt = build(spec, req)
    with gpu:
        if cur != mid:
            raise HTTPException(503, f"{spec['label']}을 올리는 중입니다. 잠시 뒤 다시 눌러주세요.")
        g = torch.Generator("cuda").manual_seed(seed)
        a = args_for(spec, prompt, w, h, steps, guide, g, refs, req.strength, NEG_REAL if real(req) else NEG)
        try:
            return pipes["ref" if refs else "txt"](**a).images[0]
        except torch.OutOfMemoryError:
            # 카드가 꽉 찼다. 사람에게 「서버가 꺼졌다」고 하지 않는다. 내렸다 다시 올리고,
            # 503 으로 돌려준다 — 화면은 503 을 보면 기다렸다가 저절로 다시 누른다
            _unload()
            _kick(mid)
            raise HTTPException(
                503, f"GPU 메모리가 가득 차서 {spec['label']}을 다시 올립니다"
                     f"(약 {max(1, round(wait_s(mid) / 60))}분). 준비되면 다시 만듭니다.") from None

def extracting(req: Req) -> bool:
    """자산 뽑기 요청인가. 이때만 감독도 통과한다(ASSET_ROLES)"""
    return str(req.refKind or "").startswith("asset_")

@app.post("/gen")
async def gen(req: Req, authorization: str | None = Header(None)):
    who(authorization, need_art=True, roles=ASSET_ROLES if extracting(req) else ART_ROLES)
    mid = pick_for(req)
    if cur != mid:
        # 영상 일감을 받아 둔 채로 그림 모델을 올리면 영상 모델이 내려가고, 이미 「만듭니다」로
        # 보이던 그 일감이 엎어진다. 그림 쪽을 기다리게 한다 — 이쪽은 다시 눌러도 되지만
        # 저쪽은 다시 되돌릴 수 없다
        if vid_pending():
            raise HTTPException(503, "지금 영상을 만들고 있습니다. 끝나면 이어서 눌러주세요.")
        _kick(mid)
        raise HTTPException(503, err_for(mid) or
                            f"{MODELS[mid]['label']}을 올리는 중입니다"
                            f"(약 {max(1, round(wait_s(mid) / 60))}분). 준비되면 다시 눌러주세요.")

    t = time.time()
    seed = seed_of(req.seed)
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
    # /gen 과 같은 이유로, 도는 영상 일감이 있으면 갈지 않는다
    if cur != mid and vid_pending():
        raise HTTPException(503, "지금 영상을 만들고 있습니다. 끝나면 이어서 눌러주세요.")
    # 사람이 고른 것이다. 지난 실패가 있어도 다시 해 본다(키를 새로 넣었을 수 있다)
    _kick(mid, force=True)
    return {"ok": True, "modelId": mid, "resident": cur, "loading": loading, "wait": wait_s(mid)}

VID_MODEL = "wan"

class Vid(BaseModel):
    still: str = ""
    prompt: str = ""
    secs: float = 2
    quality: str = "fast"
    seed: int | None = None

def frames_for(secs: float) -> int:
    """Wan 은 4의 배수 + 1 프레임만 받는다. 초를 가장 가까운 그 수로 맞춘다"""
    n = max(1, round(float(secs) * FPS))
    return max(17, round((n - 1) / 4) * 4 + 1)

def vid_size(im: Image.Image, area: int) -> tuple[int, int]:
    """컷의 비율을 지키고 넓이만 화질 칸에 맞춘다. Wan 은 32 의 배수만 받는다"""
    mod = 32
    ar = im.height / max(1, im.width)
    return (max(mod, int((area / ar) ** 0.5) // mod * mod),
            max(mod, int((area * ar) ** 0.5) // mod * mod))

def eta(quality: str, secs: float) -> int:
    return round(EST[quality] * secs)

# 첫 프레임은 우리 이미지 통에 있는 그림만 받는다. 아무 주소나 받으면 이 서버가
# 남의 주소를 대신 부르는 통로가 된다
KEY_OK = re.compile(r"^img/(?!.*\.\.)[\w./-]+\.(png|jpg|jpeg|webp)$")

def key_of(src: str) -> str:
    body = (src or "").strip().split("?", 1)[0]
    i = body.find("img/")
    return body[i:] if i >= 0 else body.lstrip("/")

def still(src: str) -> Image.Image:
    if (src or "").startswith("data:"):
        return decode(src).convert("RGB")
    key = key_of(src)
    if not KEY_OK.match(key):
        raise HTTPException(400, "컷 그림 주소를 읽을 수 없습니다")
    import boto3

    raw = boto3.client("s3", region_name=REGION).get_object(Bucket=BUCKET, Key=key)["Body"].read()
    return Image.open(io.BytesIO(raw)).convert("RGB")

def put_mp4(frames) -> str:
    import boto3
    from diffusers.utils import export_to_video

    key = f"img/{uuid.uuid4().hex}.mp4"
    path = f"/tmp/{key[4:]}"
    # 파일 만들기도 try 안에 둔다. 여기서 엎어지면 쓰다 만 파일이 /tmp 에 그대로 남고,
    # 이 상자의 /tmp 는 모델 캐시와 같은 200GB 를 나눠 쓴다
    try:
        export_to_video(frames, path, fps=FPS)
        with open(path, "rb") as f:
            boto3.client("s3", region_name=REGION).put_object(
                Bucket=BUCKET, Key=key, Body=f.read(), ContentType="video/mp4",
                CacheControl="public, max-age=31536000, immutable",
            )
    finally:
        os.path.exists(path) and os.remove(path)
    return f"/{key}"

def _animate(jid: str) -> None:
    import torch

    j = JOBS[jid]
    try:
        im = still(j["still"])
        q = VQ[j["quality"]]
        w, h = vid_size(im, q["area"])
        # 움직임 지시는 컷 내용 뒤에 붙인다. 한국어면 en() 이 영어로 옮긴다
        prompt = f"{en(j['prompt'])[:300]}. {MOTION}".lstrip(". ")
        t = time.time()
        with gpu:
            if cur != VID_MODEL:
                raise HTTPException(503, "영상 모델이 아직 안 올라왔습니다")
            j.update(status="run", size=[w, h])

            def tick(pipe, step, ts, kw):
                j["step"] = step + 1
                return kw

            out = pipes["vid"](
                image=im.resize((w, h), Image.LANCZOS), prompt=prompt, negative_prompt=VNEG,
                height=h, width=w, num_frames=j["frames"], num_inference_steps=q["steps"],
                guidance_scale=MODELS[VID_MODEL]["guide"],
                generator=torch.Generator("cuda").manual_seed(j["seed"]),
                callback_on_step_end=tick,
            ).frames[0]
        # 파일 만들기와 올리기는 잠금 밖에서 한다. 다음 컷이 그만큼 먼저 시작한다
        j.update(url=put_mp4(out), ms=int((time.time() - t) * 1000), status="done")
    except torch.OutOfMemoryError:
        # 영상은 프레임을 풀 때가 제일 무겁다. 여기서 터지면 카드를 비워 둔다.
        # 그대로 두면 다음 사람의 그림까지 같이 죽는다
        with gpu:
            _unload()
        _kick(VID_MODEL)
        j.update(status="error", error="GPU 메모리가 가득 찼습니다. 영상 모델을 다시 올립니다."
                                      " 잠시 뒤 다시 눌러주세요.")
    except Exception as e:
        j.update(status="error", error=getattr(e, "detail", None) or f"{type(e).__name__}: {e}")
    finally:
        # 어느 길로 나가든 끝난 표시를 남긴다. 위의 메모리 처리 안에서 또 터지면 status 가
        # run 으로 남고, 그러면 vid_pending 이 계속 True 라서 이 기계의 그림 생성까지 멈춘다
        if j["status"] not in ("done", "error"):
            j.update(status="error", error="영상을 만들다 알 수 없는 이유로 끊겼습니다.")

@app.post("/gen/animate")
async def animate(req: Vid, authorization: str | None = Header(None)):
    """일감만 만들고 바로 답한다. CloudFront 가 60초에 끊으므로 기다릴 수 없다"""
    user = who(authorization, need_art=True)
    if cur != VID_MODEL:
        # 그림 모델을 올리는 중이면 끼어들지 않는다. _kick 이 loading 을 영상 모델로 덮어써
        # 그림을 기다리던 화면이 자기 사유를 잃고, 잠금이 풀리는 대로 그 그림 모델을 다시
        # 내려 둘이 번갈아 올리기만 한다. loading 은 다른 실이 바꾸므로 한 번만 읽는다
        now_load = loading
        if now_load and now_load != VID_MODEL:
            raise HTTPException(503, f"{MODELS[now_load]['label']}을 올리는 중입니다."
                                     " 그림이 먼저 준비된 뒤에 영상을 눌러주세요.")
        _kick(VID_MODEL)
        raise HTTPException(503, err_for(VID_MODEL) or
                            f"{MODELS[VID_MODEL]['label']}을 올리는 중입니다"
                            f"(약 {max(1, round(wait_s(VID_MODEL) / 60))}분). 준비되면 다시 눌러주세요.")
    if vid_pending():
        raise HTTPException(503, "다른 컷을 만들고 있습니다. 끝나면 이어서 눌러주세요.")

    q = req.quality if req.quality in VQ else "fast"
    secs = float(req.secs) if float(req.secs) in VSECS else 2.0
    jid = uuid.uuid4().hex[:12]
    JOBS[jid] = dict(
        id=jid, status="wait", user=user, still=req.still, prompt=req.prompt,
        secs=secs, quality=q, frames=frames_for(secs), step=0, steps=VQ[q]["steps"],
        seed=seed_of(req.seed),
        ts=time.time(),
    )
    for old in sorted(JOBS.values(), key=lambda x: x["ts"])[:-JOB_KEEP]:
        if old["status"] not in ("wait", "run"):
            JOBS.pop(old["id"], None)
    threading.Thread(target=lambda: _animate(jid), daemon=True).start()
    return {"job": jid, "eta": eta(q, secs), "quality": q, "secs": secs,
            "frames": frames_for(secs), "fps": FPS}

@app.get("/gen/animate/{jid}")
def animate_state(jid: str, authorization: str | None = Header(None)):
    who(authorization)
    j = JOBS.get(jid)
    if not j:
        raise HTTPException(404, "그 일감이 없습니다. 다시 눌러주세요.")
    keep = ("id", "status", "step", "steps", "url", "ms", "error", "quality", "secs",
            "size", "frames", "seed")
    return {k: j[k] for k in keep if k in j} | {"eta": eta(j["quality"], j["secs"]), "fps": FPS}

@app.get("/gen/health")
def health():
    name = None
    try:
        import torch

        name = torch.cuda.get_device_name(0) if torch.cuda.is_available() else None
    except Exception:
        pass
    # cur 은 다른 실에서 바뀝니다. 한 번만 읽어 두고 그 사본으로 답을 짭니다 — 두 번
    # 읽으면 그 사이에 None 이 되어 MODELS[None] 로 500 이 납니다
    now_cur = cur
    return {
        "ok": True, "warm": now_cur is not None, "busy": gpu.locked(),
        "model": MODELS[now_cur]["label"] if now_cur else None, "modelId": now_cur,
        # 화면이 모델을 안 고르면 이것으로 그린다(pick 의 되돌아갈 곳). 화면이 같은 이름을
        # 따로 적어 두면 여기를 바꿀 때 어긋나므로, 물어보게 한다
        "default": DEFAULT,
        "loading": loading, "wait": wait_s(loading) if loading else 0,
        "models": [{"id": k, "label": v["label"], "note": v["note"], "wait": wait_s(k),
                    "strength": v["family"] in ("chroma", "sd3"),
                    # 그림을 조건으로 받지 않는 모델. 화면이 참조 있는 요청을 다른 모델로 돌린다
                    "init": v.get("init", True),
                    "video": k in VIDEO} for k, v in MODELS.items()],
        # 사유와 그 사유의 주인. 화면은 자기가 기다리는 모델의 것일 때만 읽어야 한다
        "gpu": name, "error": load_error, "errorModel": load_error_mid,
        # 영상 칸이 물어보는 것들. 몇 초짜리를 만들 수 있고 얼마나 걸리는지
        "video": {"id": VID_MODEL, "secs": list(VSECS), "fps": FPS,
                  "quality": [{"id": k, "label": v["label"], "est": EST[k]} for k, v in VQ.items()],
                  "busy": vid_pending()},
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
    assert all(w % 16 == 0 and h % 16 == 0 for w, h in SIZE.values())
    assert SIZE["still"][0] > SIZE["cut"][0] and "still" in SIZE
    # 실사 룩. 연필 말이 빠지고 사진 말이 붙는다. 참조 앞말은 그대로다
    rl = build(MODELS["klein"], Req(prompt="p", refs=["x"], refKind="assets", style="real", kind="still"))
    assert STYLE_REAL in rl and STYLE not in rl and ASSETS in rl and "pencil" not in rl
    assert STYLE in build(MODELS["klein"], Req(prompt="p")) and STYLE_REAL not in build(MODELS["klein"], Req(prompt="p"))
    assert "sketch" in NEG_REAL and "photograph" not in NEG_REAL and "photograph" in NEG
    assert args_for(MODELS["chroma"], "p", 64, 32, 12, 2.5, None, [], 0.85, NEG_REAL)["negative_prompt"] == NEG_REAL
    assert set(ISOLATE) == {"asset_char", "asset_bg", "asset_prop"}
    assert ART_ROLES < ASSET_ROLES and {"director", "admin"} < ASSET_ROLES
    assert extracting(Req(refKind="asset_bg")) and not extracting(Req(refKind="face")) and not extracting(Req())
    # 참조가 있으면 그림을 받지 않는 모델(krea)로 가지 않는다. 없으면 고른 대로
    assert REF_MODEL == "klein"
    assert pick_for(Req(model="krea", refs=["x"])) == "klein" and pick_for(Req(model="krea", init="x")) == "klein"
    assert pick_for(Req(model="krea")) == "krea" and pick_for(Req(model="hd", refs=["x"])) == "hd"
    # 엎어진 모델은 저절로 다시 올리지 않는다. 사람이 고르면(force) 다시 해 본다
    load_error, load_error_mid = "krea: 실패", "krea"
    _kick("krea"); assert loading is None
    load_error, load_error_mid = None, None
    assert "watermark" not in STYLE and "watermark" in NEG
    sk = Image.new("RGB", (64, 32), "white")
    lit = lamp(sk)
    assert lit.size == sk.size
    assert lit.getpixel((2, 16))[0] < lit.getpixel((61, 16))[0] < 256
    assert sum(lit.getpixel((2, 16))) < 3 * 255 * 0.4

    assert set(MODELS) == {"chroma", "klein", "hd", "sd35", "krea", "wan"}
    assert MODELS["sd35"]["gated"] and MODELS["krea"]["gated"]
    assert not any(v.get("gated") for k, v in MODELS.items() if k not in ("sd35", "krea"))
    assert MODELS["krea"]["init"] is False and all(v.get("init", True) for k, v in MODELS.items() if k != "krea")
    for k, v in MODELS.items():
        assert v["family"] in FAMILY, k
        # guide 0.0 (증류판) 도 값이다 — 참인지가 아니라 있는지를 본다
        assert all(v.get(f) is not None for f in ("repo", "label", "note", "steps", "guide", "guide_ref", "gb"))
    assert FALLBACK in MODELS and FALLBACK not in VIDEO and FALLBACK == "krea"
    assert pick(None) == DEFAULT and pick("없는모델") == DEFAULT and pick("hd") == "hd"
    cur = "klein"
    assert pick(None) == "klein" and pick("hd") == "hd"
    # 영상 모델이 올라와 있어도 그림은 그림 모델로 간다. 아니면 pipes["txt"] 가 없어 터진다
    cur = "wan"
    assert pick(None) == DEFAULT and pick("wan") == DEFAULT and pick("hd") == "hd"
    cur = None
    assert wait_s("klein") < wait_s("hd") < wait_s("wan")
    # krea 는 참조를 무시한다: 앞말도 image 도 없다. NOTEXT 는 붙는다
    kr = build(MODELS["krea"], Req(prompt="p", init="x", refKind="face"))
    assert KEEP not in kr and LOOK not in kr and NOTEXT in kr
    assert ASSETS not in build(MODELS["krea"], Req(prompt="p", refs=["x"], refKind="assets"))
    akr = args_for(MODELS["krea"], "p", 64, 32, 8, 0.0, None, [Image.new("RGB", (8, 8))], 0.85)
    assert "image" not in akr and "strength" not in akr and akr["negative_prompt"] == NEG and akr["guidance_scale"] == 0.0

    assert VIDEO == {VID_MODEL} and MODELS[VID_MODEL]["family"] == "wan"
    # 프레임 수는 4의 배수 + 1 이어야 Wan 이 받는다
    assert [frames_for(s) for s in VSECS] == [49, 73, 121]
    assert all((frames_for(s) - 1) % 4 == 0 for s in (0.1, 1, 2, 3, 4.4, 5, 9))
    assert frames_for(0.1) == 17
    for q in VQ.values():
        w, h = vid_size(Image.new("RGB", SIZE["cut"]), q["area"])
        assert w % 32 == 0 and h % 32 == 0 and w * h <= q["area"]
        assert abs(w / h - SIZE["cut"][0] / SIZE["cut"][1]) < 0.1
    wv, hv = vid_size(Image.new("RGB", SIZE["pose"]), VQ["fast"]["area"])
    assert hv > wv and wv % 32 == 0 and hv % 32 == 0
    assert eta("fine", 5) > eta("fast", 5) > 0
    # 첫 프레임은 우리 통의 img/ 키만 받는다
    assert key_of("/img/a.png") == key_of("https://cdn.example/img/a.png?v=2") == "img/a.png"
    assert KEY_OK.match("img/a.png") and KEY_OK.match(key_of("/img/x/y_1.jpeg"))
    for bad in ("https://evil.example/x.png", "/etc/passwd", "img/a.txt", "", "img/../a.png"):
        assert not KEY_OK.match(key_of(bad)), bad
    assert "watermark" in VNEG and "storyboard" in MOTION

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

    # 기반 이미지가 무엇인지 말해 주면 모델 갈래와 상관없이 그 말이 앞에 온다
    for k in MODELS:
        if k in VIDEO or MODELS[k].get("init") is False:
            continue
        sk = build(MODELS[k], Req(prompt="p", init="x", refKind="sketch"))
        fa = build(MODELS[k], Req(prompt="p", init="x", refKind="face"))
        ca = build(MODELS[k], Req(prompt="p", init="x", refKind="cast"))
        kv = build(MODELS[k], Req(prompt="p", init="x", refKind="image"))
        assert FINISH in sk and KEEP not in sk, k
        assert KEEP in fa and FINISH not in fa, k
        assert CAST in ca and KEEP not in ca, k
        assert LOOK in kv and FINISH not in kv, k
    # 모르는 값은 「그림 한 장」으로 봅니다 — 구도까지 물려받는 것이 가장 나쁜 기본값입니다
    assert LOOK in build(MODELS["klein"], Req(prompt="p", init="x", refKind="???"))
    # 자산 뽑기와 자산 여러 장 참조. refs 만 와도 참조로 본다(init 없음)
    for k, lead in ISOLATE.items():
        out = build(MODELS["klein"], Req(prompt="p", refs=["x"], refKind=k, kind="asset"))
        assert lead in out and LOOK not in out and SHEET not in out, k
    assert ASSETS in build(MODELS["klein"], Req(prompt="p", refs=["x", "y"], refKind="assets"))
    assert KEEP not in build(MODELS["klein"], Req(prompt="p", refs=[], refKind="face"))

    ref = Image.new("RGB", (32, 32), "white")
    ac = args_for(MODELS["chroma"], "p", 64, 32, 12, 2.5, None, [ref], 0.85)
    ah = args_for(MODELS["hd"], "p", 64, 32, 26, 4.0, None, [ref], 0.85)
    ak = args_for(MODELS["klein"], "p", 64, 32, 8, 4.0, None, [ref], 0.85)
    assert ac["strength"] == 0.85 and ac["image"].size == (64, 32)
    assert ah["strength"] == 0.85 and ah["negative_prompt"] == NEG
    ax = args_for(MODELS["sd35"], "p", 64, 32, 28, 3.5, None, [ref], 0.85)
    assert ax["strength"] == 0.85 and ax["negative_prompt"] == NEG
    assert "strength" not in ak
    assert ak["image"] == [ref]
    assert "negative_prompt" not in ak and ak["guidance_scale"] == 4.0
    assert "image" not in args_for(MODELS["klein"], "p", 64, 32, 8, 4.0, None, [], 0.85)
    # 여러 장이면 klein 은 전부, img2img 갈래는 첫 장만
    two = [ref, Image.new("RGB", (16, 16), "black")]
    assert args_for(MODELS["klein"], "p", 64, 32, 8, 4.0, None, two, 0.85)["image"] == two
    assert args_for(MODELS["chroma"], "p", 64, 32, 12, 2.5, None, two, 0.85)["image"].size == (64, 32)
    # refs 가 앞, init 이 뒤. 빈 칸은 버리고 너무 많으면 앞에서 MAX_REFS 장
    got = refs_of(Req(refs=[url, ""], init=url))
    assert len(got) == 2 and all(im.size == (4, 4) for im in got)
    assert len(refs_of(Req(refs=[url] * (MAX_REFS + 3)))) == MAX_REFS
    assert refs_of(Req()) == []
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
