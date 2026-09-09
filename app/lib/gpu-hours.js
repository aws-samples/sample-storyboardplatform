/*
 * 생성 서버를 켜 두는 시간표.
 *
 * GPU 는 EC2 한 대이고, EventBridge Scheduler 두 개가 평일 09:00 에 켜고 20:00 에
 * 끕니다(한국 시간). 그래서 그 시간 밖에서는 /health 가 닿지 않는 것이 정상입니다.
 * 화면이 「인스턴스가 꺼져 있을 수 있습니다」 라고만 적으면, 읽는 사람은 고장인지
 * 원래 그런 것인지 알 수 없어서 기다릴지 고칠지 정하지 못합니다. 그래서 시간표를
 * 그대로 적고 다음에 켜지는 때까지 알려줍니다.
 *
 * 유휴 감지가 아니라 스케줄입니다. 아침 9시에 아무도 쓰지 않아도 켜져 있고, 저녁
 * 8시에 그리는 중이어도 꺼집니다. 여기 적는 말이 그 사실과 어긋나면 안 됩니다.
 *
 * 시간을 고치려면 infra/lib/storyboard-stack.js 의 GPU_HOURS 와 여기를 같이 고쳐야
 * 합니다. 인프라만 고치면 화면이 없는 시간을 알려주고, 여기만 고치면 화면이 거짓말을
 * 합니다. app/test.html 이 두 값이 같은지 지킵니다.
 */

/** 켜는 시각과 끄는 시각. 한국 시간(KST = UTC+9)의 시(hour) 입니다 */
export const GPU_ON_HOUR = 9
export const GPU_OFF_HOUR = 20

/** 시간표를 사람이 읽는 한 줄로. 여러 화면이 같은 문장을 쓰도록 여기서 만듭니다 */
export const GPU_HOURS_TEXT = `평일 ${String(GPU_ON_HOUR).padStart(2, '0')}:00–`
  + `${String(GPU_OFF_HOUR).padStart(2, '0')}:00 (한국 시간)`

const DAYS = ['일요일', '월요일', '화요일', '수요일', '목요일', '금요일', '토요일']

/**
 * 어느 표준시에서 열어도 한국 시간으로 읽습니다. 보는 사람이 서울에 있지 않을 수
 * 있고, 시간표는 서울 기준이라서 브라우저의 표준시로 재면 어긋납니다. 한국은 일광
 * 절약시간제를 쓰지 않으므로 UTC+9 를 그대로 더하면 됩니다.
 *
 * @param {Date|number|string} [at] - 기준 시각. 없으면 지금
 * @returns {{day: number, hour: number}} 한국 시간의 요일(0=일)과 시
 */
function kstNow(at) {
  const d = at === undefined ? new Date() : new Date(at)
  const t = new Date(d.getTime() + 9 * 3600 * 1000)
  return { day: t.getUTCDay(), hour: t.getUTCHours() }
}

/**
 * 지금이 켜 두는 시간인지 봅니다.
 *
 * @param {Date|number|string} [at] - 기준 시각. 없으면 지금
 * @returns {boolean} 평일 09:00~20:00 (한국 시간) 이면 true
 */
export function gpuHoursOpen(at) {
  const { day, hour } = kstNow(at)
  if (day === 0 || day === 6) return false
  return hour >= GPU_ON_HOUR && hour < GPU_OFF_HOUR
}

/**
 * 다음에 켜지는 때를 사람이 읽는 말로. 「내일」 은 토·일을 건너뛰지 않으므로
 * 금요일 밤과 주말에는 요일을 그대로 적습니다.
 *
 * @param {Date|number|string} [at] - 기준 시각. 없으면 지금
 * @returns {string} 예: `오늘 오전 9시` · `내일 오전 9시` · `월요일 오전 9시`
 */
export function nextGpuOn(at) {
  const { day, hour } = kstNow(at)
  const when = `오전 ${GPU_ON_HOUR}시`

  // 평일 아침, 아직 켜지기 전
  if (day >= 1 && day <= 5 && hour < GPU_ON_HOUR) return `오늘 ${when}`
  // 월~목 저녁. 다음 날이 평일입니다
  if (day >= 1 && day <= 4) return `내일 ${when}`
  // 금요일 저녁 · 토 · 일. 다음은 월요일입니다
  if (day === 5 || day === 6 || day === 0) return `${DAYS[1]} ${when}`
  return when
}

/**
 * 생성 서버에 닿지 않을 때 화면에 적는 말. 시간표 밖이면 기다리면 된다고,
 * 시간표 안이면 볼 것이 있다고 알려줍니다. 둘을 가르는 것이 이 함수의 전부입니다.
 *
 * @param {Date|number|string} [at] - 기준 시각. 없으면 지금
 * @returns {string} 화면에 그대로 넣는 한 줄
 */
/*
 * 2026-09-09 부터 저녁에 끄는 시간표가 없습니다. 끄는 것은 사람이 「GPU 끄기」로 하고, 켜는 것도
 * 「GPU 켜기」로 합니다(pages/board.js · pages/assets.js). 아침 9시 켜기만 시간표에 남아 있습니다.
 * 그래서 이 문구는 「언제 켜진다」가 아니라 「어떻게 켠다」를 말합니다. at 은 문구에 안 쓰지만
 * 부르는 쪽 서명은 그대로 둡니다.
 */
export function gpuDownHint(at) {
  const morning = gpuHoursOpen(at) ? '' : ` 평일 ${GPU_ON_HOUR}시에는 저절로 켜집니다.`
  return `생성 서버가 꺼져 있습니다. 「GPU 켜기」를 누르면 약 3~4분 뒤 준비됩니다.${morning}`
}
