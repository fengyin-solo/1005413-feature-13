<template>
  <section class="page" data-module="refuge">
    <header class="page-head">
      <div>
        <h2>避险场所管理</h2>
        <p class="page-desc">维护避险场所，围绕场所编号、场所名称、可容纳人数、开放条件做登记、筛选与状态流转。</p>
      </div>
      <div class="page-actions">
        <button class="btn primary" type="button" @click="openCreate">登记避险场所</button>
        <button class="btn primary" type="button" @click="exportBooklets">按开放条件导出成册</button>
        <button class="btn" type="button" @click="exportRows">导出避险场所清单</button>
      </div>
    </header>

    <section v-if="bookletResult" class="booklet-result">
      <h3>汛前成册报送结果</h3>
      <p class="booklet-message">{{ bookletResult.message }}</p>
      <ul class="booklet-list">
        <li v-for="item in bookletResult.booklets" :key="item.condition">
          避险场所册-{{ item.condition }}.csv：{{ item.count }} 处场所（场所编号 / 可容纳人数 / 场所负责人 / 启用日期）
        </li>
        <li v-for="condition in bookletResult.emptyConditions" :key="condition">
          避险场所册-{{ condition }}-说明.txt：该条件暂无记录，已附说明，未发空册
        </li>
      </ul>
      <p v-if="bookletResult.returned.length" class="booklet-returned">
        可容纳人数精度不够，已退回校准（优先于开放条件判定）：
        {{ bookletResult.returned.map((item) => `${item.code}（${item.capacity || '未填'}）`).join('、') }}
      </p>
      <p class="booklet-rain">
        雨量站网清单：{{ bookletResult.rainRow['站号'] }}「{{ bookletResult.rainRow['站点名称'] }}」
        （{{ bookletResult.rainInserted ? '本次新增' : '已存在，本次仅更新，未多出记录' }}），
        登记开放条件：{{ bookletResult.rainRow['所属流域'] }}；
        两处比对{{ bookletResult.consistent ? '一致' : '不一致，请重新导出' }}。
      </p>
    </section>

    <div class="stat-row">
      <article v-for="item in stats" :key="item.label" class="stat-card">
        <span class="stat-label">{{ item.label }}</span>
        <strong class="stat-value">{{ item.value }}</strong>
      </article>
    </div>

    <p class="status-legend">
      <span v-for="item in statusSummary" :key="item.status" class="legend-item">
        {{ item.status }}：{{ item.count }}
      </span>
    </p>

    <form class="filter-bar" @submit.prevent="reload">
      <label v-for="field in filterFields" :key="field" class="filter-item">
        <span>{{ field }}</span>
        <input v-model="filters[field]" :placeholder="`按${field}检索`" />
      </label>
      <button class="btn" type="submit">查询</button>
      <button class="btn ghost" type="button" @click="resetFilters">重置条件</button>
    </form>

    <table class="data-table">
      <thead>
        <tr>
          <th v-for="column in columns" :key="column">{{ column }}</th>
          <th>当前状态</th>
          <th>可执行动作</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="row in rows" :key="String(row.id)">
          <td v-for="column in columns" :key="column">{{ row[column] ?? '—' }}</td>
          <td>{{ row.status }}</td>
          <td class="row-actions">
            <button
              v-for="action in actions"
              :key="action"
              class="link"
              type="button"
              @click="runAction(action, row)"
            >
              {{ action }}
            </button>
          </td>
        </tr>
        <tr v-if="!rows.length">
          <td :colspan="columns.length + 2" class="empty-state">暂无避险场所数据，可先登记避险场所</td>
        </tr>
      </tbody>
    </table>

    <footer class="page-foot">
      <span>共 {{ total }} 条避险场所记录</span>
      <span v-if="errorMessage" class="error-text">{{ errorMessage }}</span>
    </footer>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'

import {
  downloadEntries,
  listEntries,
  moduleMeta,
  runAction as applyAction,
} from '@/api/local-service'
import { downloadRefugeBooklets } from '@/api/refuge-booklets'
import type { RefugeBookletResult } from '@/api/refuge-booklets'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('refuge')
const columns = ["场所编号", "场所名称", "可容纳人数", "开放条件", "场所负责人", "联系电话", "启用日期", "场所状态"]
const actions = ["提交核验", "确认启用", "办理关闭"]
const statuses = ["待核验", "可启用", "已启用", "已关闭"]
const stats = [{"label": "可启用场所", "value": 0}, {"label": "已启用场所", "value": 0}, {"label": "可容纳人数合计", "value": 0}]

const rows = ref<EntryRow[]>([])
const total = ref(0)
const errorMessage = ref('')
const bookletResult = ref<RefugeBookletResult | null>(null)
const filters = ref<Record<string, string>>({})
const filterFields = columns.slice(0, 3)
const statusSummary = computed(() =>
  statuses.map((status: string) => ({
    status,
    count: rows.value.filter((row) => String(row.status) === status).length,
  })),
)

function resetFilters() {
  filters.value = {}
  reload()
}

function exportRows() {
  downloadEntries(meta.key)
}

function exportBooklets() {
  errorMessage.value = ''
  bookletResult.value = downloadRefugeBooklets()
  reload()
}

function openCreate() {
  errorMessage.value = '避险场所登记入口尚未接入审批流'
}

function runAction(action: string, row: EntryRow) {
  errorMessage.value = ''
  const result = applyAction(meta.key, Number(row.id), action)
  if (!result.ok) {
    errorMessage.value = result.message
    return
  }
  reload()
}

function reload() {
  errorMessage.value = ''
  try {
    const payload = listEntries(meta.key, filters.value)
    rows.value = payload.items
    total.value = payload.total
  } catch (error) {
    errorMessage.value = error instanceof Error ? error.message : '避险场所列表读取失败'
  }
}

onMounted(reload)
</script>
