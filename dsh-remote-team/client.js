/**
 * Web half of the bundle. Registers a plugin-detail section. It is pure
 * presentation: live machine data needs a Typert Remote API (planned P4), so
 * this panel currently documents the model-facing tools instead of faking data.
 */
window.__ModuleLoader__.load({
  id: 'dsh-remote-team',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const rows = [
      ['remote_team_list / probe', '机器清单与在线状态'],
      ['remote_team_route', '按 tags / 负载 / 状态推荐机器'],
      ['remote_team_run', '在指定（或自动选择）的机器上执行任务'],
      ['remote_team_parallel', '多机并行并汇总'],
      ['remote_team_status / output / cancel', '查询、读取结果、取消'],
      ['spawn_remote_teammate', '创建绑定某台机器的 agent-team 队友'],
      ['assign_remote_task', '用队友已绑定的机器再派一个任务'],
    ]

    function Panel() {
      return h('div', { style: { padding: '12px 4px', lineHeight: 1.6, fontSize: '13px' } },
        h('p', { style: { margin: '0 0 8px' } },
          '远程智能体团队：用 DSH 内置 agent-team 调度其他 Windows 机器上的 Pi coding agent。'),
        h('p', { style: { margin: '0 0 8px', opacity: 0.75 } },
          '模型可按次指定 machine；省略时按能力标签、并发余量与在线状态自动路由。'),
        h('table', { style: { borderCollapse: 'collapse', width: '100%' } },
          h('tbody', null, rows.map(([name, description]) =>
            h('tr', { key: name },
              h('td', { style: { padding: '3px 10px 3px 0', fontFamily: 'monospace', whiteSpace: 'nowrap' } }, name),
              h('td', { style: { padding: '3px 0', opacity: 0.8 } }, description))))),
        h('p', { style: { margin: '10px 0 0', opacity: 0.6 } },
          '实时看板数据需要 Typert Remote API，当前版本请在对话中使用上表工具。'))
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('plugins.detail.section', () => ctx.slots.register({
          name: 'plugins.detail.section',
          id: 'dsh-remote-team',
          order: 20,
        }, Panel))
      },
    }
  },
})
