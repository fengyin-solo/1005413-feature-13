import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 汛前报送：把能启用的避险场所按开放条件整理成册，结论同步落到雨量站网清单。
// 判定优先级：可容纳人数精度校验先于开放条件分组——精度不够的一律退回校准，不进任何一册。

/** 汛前报送按这几档开放条件成册；没有记录的条件也要给说明文件，不发空册。 */
export const OPEN_CONDITIONS = [
  '暴雨蓝色预警',
  '暴雨黄色预警',
  '暴雨橙色预警',
  '暴雨红色预警',
  '地质灾害气象风险预警',
]

/** 能启用 = 可启用 / 已启用；待核验、已关闭不进册。 */
const REPORTABLE_STATUSES = ['可启用', '已启用']

/** 落到雨量站网清单的落实记录用固定站号，重复导出只更新这一条，不会多出第二条。 */
const RAIN_RECORD_CODE = 'REFUGE-BOOKLET'

export type BookletFile = { filename: string; content: string }

export type ReturnedRow = { id: number; code: string; capacity: string }

export type RefugeBookletResult = {
  files: BookletFile[]
  booklets: { condition: string; count: number }[]
  emptyConditions: string[]
  returned: ReturnedRow[]
  rainRow: EntryRow
  rainInserted: boolean
  consistent: boolean
  message: string
}

/** 可容纳人数必须精确到个位的正整数，「约260」「150.5」这类都算精度不够。 */
function capacityOf(row: EntryRow): number | null {
  const raw = String(row['可容纳人数'] ?? '').trim()
  if (!/^\d+$/.test(raw)) {
    return null
  }
  const value = Number(raw)
  return value > 0 ? value : null
}

function todayText(): string {
  const now = new Date()
  const month = String(now.getMonth() + 1).padStart(2, '0')
  const day = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${month}-${day}`
}

export function exportRefugeBooklets(): RefugeBookletResult {
  const rows = listRows('refuge')

  // 第一刀先切精度：可容纳人数不过关的退回校准并标异常，不再参与后面的分组。
  const returned: ReturnedRow[] = []
  const nextRows = rows.map((row) => {
    if (capacityOf(row) !== null) {
      return row
    }
    returned.push({
      id: Number(row.id),
      code: String(row['场所编号'] ?? row.id),
      capacity: String(row['可容纳人数'] ?? ''),
    })
    return { ...row, abnormal: true }
  })
  if (returned.length > 0) {
    saveRows('refuge', nextRows)
  }
  const calibrated = new Set(returned.map((item) => item.id))
  const reportable = rows.filter(
    (row) => !calibrated.has(Number(row.id)) && REPORTABLE_STATUSES.includes(String(row.status)),
  )

  // 按开放条件分册，预定义条件先占位，记录里冒出来的新条件也照样成册。
  const byCondition = new Map<string, EntryRow[]>()
  for (const condition of OPEN_CONDITIONS) {
    byCondition.set(condition, [])
  }
  for (const row of reportable) {
    const condition = String(row['开放条件'] ?? '').trim() || '未填开放条件'
    if (!byCondition.has(condition)) {
      byCondition.set(condition, [])
    }
    byCondition.get(condition)!.push(row)
  }

  const files: BookletFile[] = []
  const booklets: { condition: string; count: number }[] = []
  const emptyConditions: string[] = []
  for (const [condition, group] of byCondition) {
    if (group.length === 0) {
      emptyConditions.push(condition)
      files.push({
        filename: `避险场所册-${condition}-说明.txt`,
        content: [
          `避险场所册（${condition}）说明`,
          `导出日期：${todayText()}`,
          '',
          `截至导出时，开放条件为「${condition}」的可启用场所暂无记录，本册不提供空表。`,
          '待该条件下有场所核验通过后再行补报。',
        ].join('\n'),
      })
      continue
    }
    const sorted = [...group].sort((a, b) =>
      String(a['场所编号']).localeCompare(String(b['场所编号'])),
    )
    const lines = ['场所编号,可容纳人数,场所负责人,启用日期']
    for (const row of sorted) {
      lines.push(
        [row['场所编号'], row['可容纳人数'], row['场所负责人'], row['启用日期']].join(','),
      )
    }
    booklets.push({ condition, count: sorted.length })
    files.push({
      filename: `避险场所册-${condition}.csv`,
      content: `\uFEFF${lines.join('\n')}`,
    })
  }

  // 结论落到雨量站网清单：固定站号一条记录，已存在就更新，保证重复导出不多条。
  const bookedConditions = booklets.map((item) => item.condition)
  const rainRows = listRows('rain')
  const existingIndex = rainRows.findIndex((row) => String(row['站号']) === RAIN_RECORD_CODE)
  const rainRow: EntryRow = {
    id:
      existingIndex >= 0
        ? Number(rainRows[existingIndex].id)
        : rainRows.reduce((max, row) => Math.max(max, Number(row.id)), 0) + 1,
    status: '运行正常',
    pending: false,
    abnormal: false,
    站号: RAIN_RECORD_CODE,
    站点名称: `已落实场所${reportable.length}处`,
    所属流域: bookedConditions.join('、') || '无',
    设备型号: '避险场所册',
    阈值雨量: String(reportable.length),
    通信方式: '按开放条件成册',
    校核日期: todayText(),
    站点状态: '已落实',
  }
  const nextRain =
    existingIndex >= 0
      ? rainRows.map((row, index) => (index === existingIndex ? rainRow : row))
      : [...rainRows, rainRow]
  saveRows('rain', nextRain)

  // 两处比对：成册的开放条件与雨量站网清单里登记的必须对得上。
  const recorded = String(rainRow['所属流域']).split('、').filter((item) => item && item !== '无')
  const consistent =
    recorded.length === bookedConditions.length &&
    bookedConditions.every((condition) => recorded.includes(condition))

  const message = consistent
    ? `已导出${booklets.length}册、${emptyConditions.length}份空条件说明，退回校准${returned.length}条；雨量站网清单已同步，两处开放条件比对一致。`
    : `已导出但雨量站网清单与成册开放条件对不上，请核对后重新导出。`
  return {
    files,
    booklets,
    emptyConditions,
    returned,
    rainRow,
    rainInserted: existingIndex < 0,
    consistent,
    message,
  }
}

function downloadFile(file: BookletFile): void {
  const blob = new Blob([file.content], { type: 'text/plain;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}

/** 逐册下载，隔开一点时间，免得浏览器把多文件下载拦下。 */
export function downloadRefugeBooklets(): RefugeBookletResult {
  const result = exportRefugeBooklets()
  result.files.forEach((file, index) => {
    window.setTimeout(() => downloadFile(file), index * 300)
  })
  return result
}
