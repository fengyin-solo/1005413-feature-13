import { listRows, saveRows } from '@/data/local-store'
import type { EntryRow } from '@/data/types'

// 避险场所分册导出：汛前把能启用的场所按开放条件整理成册，直接发乡镇。
// 判定优先级（可容纳人数与开放条件撞在一起时按此顺序）：
//   1. 可容纳人数精度校验最优先——精度不足的一律退回校准，不进任何分册；
//   2. 开放条件决定场所归入哪一册；
//   3. 同一册内按可容纳人数从多到少排列，并列时按场所编号升序。

const REFUGE_KEY = 'refuge'

// 已落实场所清单挂在雨量站网一侧：key 固定，雨量站网页面直接读这份清单。
export const SETTLEMENT_STORE_KEY = 'refuge-settlements'

// 只有「能启用」的场所才进册：可启用、已启用；待核验、已关闭不进册。
export const EXPORTABLE_STATUSES = ['可启用', '已启用']

export type BookletFile = {
  filename: string
  content: string
  kind: 'booklet' | 'notice' | 'calibration' | 'manifest'
}

export type BookletSummary = {
  condition: string
  count: number
  filename: string
}

export type ConditionNotice = {
  condition: string
  filename: string
  reason: string
}

export type CalibrationReturn = {
  场所编号: string
  场所名称: string
  开放条件: string
  可容纳人数: string
  当前状态: string
  reason: string
}

export type LedgerSync = {
  added: number
  updated: number
}

export type SettlementMismatch = {
  场所编号: string
  清单开放条件: string
  台账开放条件: string
}

export type BookletExportResult = {
  exportedAt: string
  files: BookletFile[]
  booklets: BookletSummary[]
  notices: ConditionNotice[]
  calibrations: CalibrationReturn[]
  ledger: LedgerSync
  mismatches: SettlementMismatch[]
}

type ReadyItem = {
  row: EntryRow
  capacity: number
}

// 可容纳人数必须是正整数；写成「约200」「200人」这类都视为精度不够，先退回校准。
export function parseCapacity(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 ? value : null
  }
  const text = String(value ?? '').trim()
  if (!/^\d+$/.test(text)) {
    return null
  }
  const parsed = Number(text)
  return parsed > 0 ? parsed : null
}

function conditionOf(row: EntryRow): string {
  const text = String(row['开放条件'] ?? '').trim()
  return text === '' ? '未填写开放条件' : text
}

function codeOf(row: EntryRow): string {
  return String(row['场所编号'] ?? '')
}

function textOf(row: EntryRow, field: string): string {
  return String(row[field] ?? '')
}

function bookletFilename(condition: string): string {
  return `避险场所册-开放条件-${sanitizeFilename(condition)}.csv`
}

function sanitizeFilename(name: string): string {
  return name.replace(/[\\/:*?"<>|\s]+/g, '-')
}

function csvCell(value: unknown): string {
  const text = String(value ?? '')
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function toCsv(header: string[], lines: unknown[][]): string {
  const rows = [header, ...lines].map((line) => line.map(csvCell).join(','))
  return `\uFEFF${rows.join('\n')}`
}

function formatDateTime(value: Date): string {
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())} ${pad(value.getHours())}:${pad(value.getMinutes())}:${pad(value.getSeconds())}`
}

// 某个开放条件一条符合导出条件的记录都没有时，说明文件里要写清原因，不给空册。
function noticeReason(condition: string, rows: EntryRow[]): string {
  const related = rows.filter((row) => conditionOf(row) === condition)
  const calib = related.filter((row) => parseCapacity(row['可容纳人数']) === null)
  const unready = related.filter(
    (row) => parseCapacity(row['可容纳人数']) !== null && !EXPORTABLE_STATUSES.includes(String(row.status)),
  )
  const parts: string[] = []
  if (calib.length > 0) {
    parts.push(`${calib.length} 条记录可容纳人数精度不足，已退回校准（${calib.map(codeOf).join('、')}）`)
  }
  if (unready.length > 0) {
    const statuses = [...new Set(unready.map((row) => String(row.status)))].join('、')
    parts.push(`${unready.length} 条记录状态为「${statuses}」，不在可启用范围`)
  }
  if (parts.length === 0) {
    parts.push('台账中没有登记该开放条件下的场所')
  }
  return parts.join('；')
}

// 导出结论落到雨量站网的已落实场所清单：按场所编号对账，重复导出原地更新，不会多出第二条。
function syncSettlements(items: ReadyItem[], exportedAt: string): LedgerSync {
  const rows = [...listRows(SETTLEMENT_STORE_KEY)]
  const byCode = new Map(rows.map((row) => [codeOf(row), row]))
  let nextId = rows.reduce((max, row) => Math.max(max, Number(row.id) || 0), 0) + 1
  let added = 0
  let updated = 0
  for (const { row, capacity } of items) {
    const code = codeOf(row)
    const condition = conditionOf(row)
    const existing = byCode.get(code)
    if (existing) {
      existing['开放条件'] = condition
      existing['可容纳人数'] = capacity
      existing['场所负责人'] = textOf(row, '场所负责人')
      existing['启用日期'] = textOf(row, '启用日期')
      existing['册名'] = bookletFilename(condition)
      existing['最近核对时间'] = exportedAt
      updated += 1
    } else {
      rows.push({
        id: nextId,
        status: '已落实',
        pending: false,
        abnormal: false,
        场所编号: code,
        开放条件: condition,
        可容纳人数: capacity,
        场所负责人: textOf(row, '场所负责人'),
        启用日期: textOf(row, '启用日期'),
        册名: bookletFilename(condition),
        落实时间: exportedAt,
        最近核对时间: exportedAt,
      })
      nextId += 1
      added += 1
    }
  }
  saveRows(SETTLEMENT_STORE_KEY, rows)
  return { added, updated }
}

export function listSettlements(): EntryRow[] {
  return listRows(SETTLEMENT_STORE_KEY)
}

// 两处比对：雨量站网清单里的开放条件，要和避险场所台账当前值对得上。
export function verifySettlements(): SettlementMismatch[] {
  const refugeByCode = new Map(listRows(REFUGE_KEY).map((row) => [codeOf(row), row]))
  const mismatches: SettlementMismatch[] = []
  for (const item of listRows(SETTLEMENT_STORE_KEY)) {
    const refuge = refugeByCode.get(codeOf(item))
    const ledgerCondition = String(item['开放条件'] ?? '')
    const refugeCondition = refuge ? conditionOf(refuge) : '（台账中不存在）'
    if (!refuge || refugeCondition !== ledgerCondition) {
      mismatches.push({
        场所编号: codeOf(item),
        清单开放条件: ledgerCondition,
        台账开放条件: refugeCondition,
      })
    }
  }
  return mismatches
}

export function exportRefugeBooklets(now: Date = new Date()): BookletExportResult {
  const rows = listRows(REFUGE_KEY)
  const exportedAt = formatDateTime(now)

  // 第一优先级：可容纳人数精度不够的先进退回校准清单，并标异常，看板上能看出来。
  const calibrations: CalibrationReturn[] = []
  const ready: ReadyItem[] = []
  for (const row of rows) {
    const capacity = parseCapacity(row['可容纳人数'])
    if (capacity === null) {
      calibrations.push({
        场所编号: codeOf(row),
        场所名称: textOf(row, '场所名称'),
        开放条件: conditionOf(row),
        可容纳人数: String(row['可容纳人数'] ?? ''),
        当前状态: String(row.status),
        reason: '可容纳人数不是精确的正整数，先退回校准',
      })
      continue
    }
    if (EXPORTABLE_STATUSES.includes(String(row.status))) {
      ready.push({ row, capacity })
    }
  }
  if (calibrations.length > 0) {
    const flagged = new Set(calibrations.map((item) => item.场所编号))
    saveRows(
      REFUGE_KEY,
      rows.map((row) => (flagged.has(codeOf(row)) && !row.abnormal ? { ...row, abnormal: true } : row)),
    )
  }

  // 第二优先级：开放条件决定归属哪一册。
  const groups = new Map<string, ReadyItem[]>()
  for (const item of ready) {
    const condition = conditionOf(item.row)
    const group = groups.get(condition) ?? []
    group.push(item)
    groups.set(condition, group)
  }

  const files: BookletFile[] = []
  const booklets: BookletSummary[] = []
  const notices: ConditionNotice[] = []

  const conditions = [...new Set(rows.map(conditionOf))]
  for (const condition of conditions) {
    const group = groups.get(condition)
    if (group && group.length > 0) {
      // 第三优先级：册内按可容纳人数从多到少，并列按场所编号升序。
      const sorted = [...group].sort(
        (a, b) => b.capacity - a.capacity || codeOf(a.row).localeCompare(codeOf(b.row)),
      )
      const filename = bookletFilename(condition)
      const content = toCsv(
        ['场所编号', '可容纳人数', '场所负责人', '启用日期'],
        sorted.map(({ row, capacity }) => [
          codeOf(row),
          capacity,
          textOf(row, '场所负责人'),
          textOf(row, '启用日期'),
        ]),
      )
      files.push({ filename, content, kind: 'booklet' })
      booklets.push({ condition, count: sorted.length, filename })
    } else {
      const reason = noticeReason(condition, rows)
      const filename = `避险场所册-开放条件-${sanitizeFilename(condition)}-说明.txt`
      const content = [
        '避险场所分册说明（本册无记录，不给空册）',
        `开放条件：${condition}`,
        `导出时间：${exportedAt}`,
        '',
        `本开放条件下暂无符合导出条件的场所：${reason}。`,
        '场所状态沿「待核验 → 可启用 → 已启用 → 已关闭」推进到可启用，且可容纳人数校准通过后，下次导出自动进册。',
      ].join('\n')
      files.push({ filename, content, kind: 'notice' })
      notices.push({ condition, filename, reason })
    }
  }

  if (calibrations.length > 0) {
    files.push({
      filename: '避险场所-退回校准清单.csv',
      content: toCsv(
        ['场所编号', '场所名称', '开放条件', '可容纳人数', '当前状态', '退回原因'],
        calibrations.map((item) => [
          item.场所编号,
          item.场所名称,
          item.开放条件,
          item.可容纳人数,
          item.当前状态,
          item.reason,
        ]),
      ),
      kind: 'calibration',
    })
  }

  const ledger = syncSettlements(ready, exportedAt)
  const mismatches = verifySettlements()

  const manifestLines = [
    '避险场所分册导出汇总',
    `导出时间：${exportedAt}`,
    '',
    '一、分册结果',
    ...booklets.map((item) => `- 开放条件「${item.condition}」：${item.count} 条，见 ${item.filename}`),
    ...notices.map((item) => `- 开放条件「${item.condition}」：无符合导出条件的记录，附说明文件 ${item.filename}，不给空册`),
    '',
    '二、退回校准（可容纳人数精度不足，校准后再报）',
    ...(calibrations.length > 0
      ? calibrations.map((item) => `- ${item.场所编号}（开放条件「${item.开放条件}」，当前值「${item.可容纳人数}」）`)
      : ['- 无']),
    '',
    '三、优先级判定（可容纳人数与开放条件撞在一起时按此判定）',
    '1. 可容纳人数精度校验最优先：精度不足的一律退回校准，不进任何分册；',
    '2. 开放条件决定场所归入哪一册；',
    '3. 同一册内按可容纳人数从多到少排列，并列时按场所编号升序。',
    '',
    '四、雨量站网清单同步',
    `已落实场所清单：新增 ${ledger.added} 条，更新 ${ledger.updated} 条；按场所编号对账，重复导出不会多出第二条。`,
    mismatches.length === 0
      ? '开放条件两处比对：全部对得上。'
      : `开放条件两处比对：${mismatches.length} 条对不上（${mismatches
          .map((item) => `${item.场所编号}：清单「${item.清单开放条件}」≠ 台账「${item.台账开放条件}」`)
          .join('；')}）`,
  ]
  files.push({ filename: '避险场所分册导出-汇总.txt', content: manifestLines.join('\n'), kind: 'manifest' })

  return { exportedAt, files, booklets, notices, calibrations, ledger, mismatches }
}

// 导出成文件后直接发：逐个触发下载，浏览器拿到一包册子+说明+清单+汇总。
export function downloadRefugeBooklets(): BookletExportResult {
  const result = exportRefugeBooklets()
  result.files.forEach((file, index) => {
    window.setTimeout(() => downloadFile(file), index * 150)
  })
  return result
}

function downloadFile(file: BookletFile): void {
  const type = file.filename.endsWith('.csv') ? 'text/csv;charset=utf-8' : 'text/plain;charset=utf-8'
  const blob = new Blob([file.content], { type })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = file.filename
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(url)
}
