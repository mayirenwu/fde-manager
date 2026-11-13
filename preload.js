/**
 * 预加载脚本 v3：最小 API 面。
 * 渲染进程（面板 / 项目控制面板 / 切换总览）只能通过这里调用主进程能力。
 */
const { contextBridge, ipcRenderer, webUtils } = require('electron');

const ALLOWED_CHANNELS = ['fde:projects', 'fde:flows', 'fde:logs', 'fde:inbox', 'fde:trash', 'fde:desktop', 'fde:canvas-run', 'fde:canvas', 'fde:setview', 'fde:packs', 'fde:apps', 'fde:ai', 'fde:ai-open', 'panel:flash', 'fde:redraw', 'fde:models', 'fde:media', 'diag:log', 'apps:tab'];

contextBridge.exposeInMainWorld('fde', {
  getData: () => ipcRenderer.invoke('data:get'),

  // 复制文本（生僻字/符号打不出来时，用复制代替手打）
  copyText: (t) => ipcRenderer.invoke('app:copy-text', String(t == null ? '' : t)),

  // 飞行记录仪：页面关键事件写进 userData/renderer.log，用于诊断"点了没反应"类问题
  logLine: (t) => { try { ipcRenderer.invoke('diag:log', String(t == null ? '' : t)).catch(() => {}); } catch (e) {} },
  openExternalUrl: (url) => ipcRenderer.invoke('app:open-url', String(url || '')),
  // 货源搜索：1688 要 GBK 编码（UTF-8 会乱码），统一交给主进程拼地址
  openSearch: (payload) => ipcRenderer.invoke('search:open', payload || {}),
  pasteText: () => ipcRenderer.invoke('app:paste-text'),

  // 面板
  togglePin: () => ipcRenderer.invoke('panel:toggle-pin'),
  // 功能窗口（能力/知识库/卖货台…）是否浮在最前，默认关
  getWinPin: () => ipcRenderer.invoke('win:pin-get'),
  setWinPin: (val) => ipcRenderer.invoke('win:pin-set', !!val),
  minimizePanel: () => ipcRenderer.invoke('panel:minimize'),
  quitApp: () => ipcRenderer.invoke('panel:quit'),
  relaunchAdmin: () => ipcRenderer.invoke('app:relaunch-admin'),
  adminState: () => ipcRenderer.invoke('app:admin-state'),
  setAdminAuto: (val) => ipcRenderer.invoke('settings:admin-auto', val),
  getAutostart: () => ipcRenderer.invoke('autostart:get'),
  setAutostart: (val) => ipcRenderer.invoke('autostart:set', val),

  // 桌面（真实切换）
  switchDesktop: (target) => ipcRenderer.invoke('desktop:switch', { target }),
  showOriginalDesktop: () => ipcRenderer.invoke('desktop:original'),
  reshowWindows: () => ipcRenderer.invoke('desktop:reshow'),
  desktopDiag: () => ipcRenderer.invoke('desktop:diag'),
  diagStats: () => ipcRenderer.invoke('diag:stats'),
  desktopRepair: () => ipcRenderer.invoke('desktop:repair'),
  currentDesktop: () => ipcRenderer.invoke('desktop:current'),
  openOverview: (view, projectId) => ipcRenderer.invoke('overview:open', { view: view || '', projectId: projectId || '' }),
  closeOverview: () => ipcRenderer.invoke('overview:close'),

  // 项目
  addProject: (name, opts) => ipcRenderer.invoke('project:add', { name: name, opts: opts || {} }),
  setProjectDirection: (id, text) => ipcRenderer.invoke('project:set-direction', { id, text }),
  buildAgents: (id, requirement) => ipcRenderer.invoke('project:build-agents', { id, requirement }),
  copyProject: (id) => ipcRenderer.invoke('project:copy', id),
  removeProject: (id, verify) => ipcRenderer.invoke('project:remove', { id, verify }),
  openProject: (id) => ipcRenderer.invoke('project:open', id),
  restartProject: (id) => ipcRenderer.invoke('project:restart', id),
  openProjectPanel: (id) => ipcRenderer.invoke('project:open-panel', id),
  closeProjectPanel: (id) => ipcRenderer.invoke('project:close-panel', id),
  restoreProject: (id) => ipcRenderer.invoke('trash:restore', id),
  purgeProject: (id) => ipcRenderer.invoke('trash:purge', id),

  // 窗口归属
  listWindows: (projectId) => ipcRenderer.invoke('windows:list', projectId),
  assignWindow: (projectId, hwnd) => ipcRenderer.invoke('windows:assign', { projectId, hwnd }),
  rescanWindows: () => ipcRenderer.invoke('windows:rescan'),

  // 壁纸
  regenWallpaper: (projectId) => ipcRenderer.invoke('wallpaper:regen', projectId),
  toggleWallpaper: (val) => ipcRenderer.invoke('wallpaper:toggle', val),

  // 配置
  setExclusive: (projectId, val) => ipcRenderer.invoke('exclusive:set', { projectId, val }),
  setStatus: (projectId, status, msg) => ipcRenderer.invoke('project:set-status', { projectId, status, msg }),
  browseFile: () => ipcRenderer.invoke('autorun:browse'),
  addAutorun: (projectId, exePath, args) => ipcRenderer.invoke('autorun:add', { projectId, path: exePath, args }),
  addUrl: (projectId, url, browserPath, browserName, name) =>
    ipcRenderer.invoke('autorun:add', { projectId, type: 'url', url, browserPath, browserName, name }),
  listBrowsers: () => ipcRenderer.invoke('browsers:list'),
  removeAutorun: (projectId, itemId) => ipcRenderer.invoke('autorun:remove', { projectId, itemId }),
  setUrlBrowser: (projectId, itemId, browserPath, browserName) =>
    ipcRenderer.invoke('autorun:setbrowser', { projectId, itemId, browserPath, browserName }),
  setAutorunDelay: (projectId, itemId, delay) => ipcRenderer.invoke('autorun:setdelay', { projectId, itemId, delay }),
  runAutorun: (projectId) => ipcRenderer.invoke('autorun:run', projectId),

  // 模块 / 脚本
  addItem: (projectId, item) => ipcRenderer.invoke('item:add', { projectId, item }),
  removeItem: (projectId, itemId) => ipcRenderer.invoke('item:remove', { projectId, itemId }),
  runItem: (projectId, itemId) => ipcRenderer.invoke('item:run', { projectId, itemId }),

  // 流程 / 提示
  addFlow: (from, to, label) => ipcRenderer.invoke('flow:add', { from, to, label }),
  removeFlow: (id) => ipcRenderer.invoke('flow:remove', id),
  sendHint: (fromId, flowId, text) => ipcRenderer.invoke('hint:send', { fromId, flowId, text }),
  clearInbox: (projectId, time) => ipcRenderer.invoke('inbox:clear', { projectId, time }),

  // 工作流画布（上下文编排）
  canvasGet: () => ipcRenderer.invoke('canvas:get'),
  canvasSave: (payload) => ipcRenderer.invoke('canvas:save', payload),
  canvasRunNode: (nodeId) => ipcRenderer.invoke('canvas:run-node', nodeId),
  canvasRunFlow: (nodeId) => ipcRenderer.invoke('canvas:run-flow', nodeId),
  canvasPrompt: (nodeId) => ipcRenderer.invoke('canvas:prompt', nodeId),
  canvasPick: (kind) => ipcRenderer.invoke('canvas:pick', kind),
  canvasExportJson: () => ipcRenderer.invoke('canvas:export-json'),
  canvasExportMd: () => ipcRenderer.invoke('canvas:export-md'),
  canvasImportJson: (mode) => ipcRenderer.invoke('canvas:import-json', mode),
  canvasClear: () => ipcRenderer.invoke('canvas:clear'),
  canvasBudget: (nodeId) => ipcRenderer.invoke('canvas:budget', nodeId),

  // 项目上下文（给 AI / 文档 / 交接用的材料）
  ctxAdd: (projectId, ctx) => ipcRenderer.invoke('ctx:add', { projectId, ctx }),
  ctxRemove: (projectId, id) => ipcRenderer.invoke('ctx:remove', { projectId, id }),
  ctxUpdate: (projectId, id, patch) => ipcRenderer.invoke('ctx:update', { projectId, id, patch }),
  ctxPack: (projectId) => ipcRenderer.invoke('ctx:pack', projectId),

  // 场景包 / 场景市场
  packList: () => ipcRenderer.invoke('pack:list'),
  packDetail: (id) => ipcRenderer.invoke('pack:detail', id),
  packApply: (packId, params, enter) => ipcRenderer.invoke('pack:apply', { packId, params, enter }),
  packExport: (projectId) => ipcRenderer.invoke('pack:export', projectId),
  packImport: () => ipcRenderer.invoke('pack:import'),
  packDelete: (id) => ipcRenderer.invoke('pack:delete', id),
  packOpenDir: () => ipcRenderer.invoke('pack:open-dir'),
  packOpenFolder: (id) => ipcRenderer.invoke('pack:open-folder', id),
  openMarket: () => ipcRenderer.invoke('pack:open-market'),
  openEcom: () => ipcRenderer.invoke('ecom:open'),
  closeMarket: () => ipcRenderer.invoke('pack:close-market'),

  // 应用功能（专家 / 技能 / 连接器 / 资料库）
  appsGet: () => ipcRenderer.invoke('apps:get'),
  appsOpen: () => ipcRenderer.invoke('apps:open'),
  appsOpenTab: (tab) => ipcRenderer.invoke('apps:open', { tab: String(tab || '') }),
  onAppsTab: (cb) => { ipcRenderer.on('apps:tab', (e, t) => { try { cb(String(t || '')); } catch (err) {} }); },
  appsClose: () => ipcRenderer.invoke('apps:close'),
  appsSave: (patch) => ipcRenderer.invoke('apps:save', patch),
  appsRemove: (id) => ipcRenderer.invoke('apps:remove', id),
  appsRestore: (key) => ipcRenderer.invoke('apps:restore', key),
  appsPurge: (key) => ipcRenderer.invoke('apps:purge', key),
  appsDuplicate: (id) => ipcRenderer.invoke('apps:duplicate', id),
  appsPrompt: (id) => ipcRenderer.invoke('apps:prompt', id),
  appsOpenFolder: (id) => ipcRenderer.invoke('apps:open-folder', id),
  appsOpenTarget: (id) => ipcRenderer.invoke('apps:open-target', id),
  appsExport: (id) => ipcRenderer.invoke('apps:export', id),
  appsImport: () => ipcRenderer.invoke('apps:import'),
  appsScan: (force) => ipcRenderer.invoke('apps:scan', !!force),
  appsInstall: (cand) => ipcRenderer.invoke('apps:install', cand),
  appsToCanvas: (id) => ipcRenderer.invoke('apps:to-canvas', id),
  builderChat: (request, images) => ipcRenderer.invoke('builder:chat', { request, images: images || [] }),
  screenCapture: () => ipcRenderer.invoke('screen:capture'),
  builderScript: (project, script, requirement) => ipcRenderer.invoke('builder:script', { project, script, requirement }),

  // AI 算力（模型与密钥，默认接 ai.my10086.cn）
  aiGet: () => ipcRenderer.invoke('ai:get'),
  aiSave: (patch) => ipcRenderer.invoke('ai:save', patch),
  aiUseProvider: (id) => ipcRenderer.invoke('ai:use-provider', id),
  aiDetect: (patch) => ipcRenderer.invoke('ai:detect', patch),
  aiModels: (patch) => ipcRenderer.invoke('ai:models', patch),
  aiTest: (patch) => ipcRenderer.invoke('ai:test', patch),
  aiChat: (payload) => ipcRenderer.invoke('ai:chat', payload),
  aiOpen: (which) => ipcRenderer.invoke('ai:open', which),
  aiBalance: () => ipcRenderer.invoke('ai:balance'),
  modelsCatalog: (refresh) => ipcRenderer.invoke('models:catalog', { refresh: !!refresh }),
  modelDetail: (name) => ipcRenderer.invoke('models:detail', name),
  mediaPick: (opts) => ipcRenderer.invoke('media:pick', opts || {}),
  mediaGenerate: (payload) => ipcRenderer.invoke('media:generate', payload),
  mediaStatus: (taskId) => ipcRenderer.invoke('media:status', taskId),
  aiOpenSettings: () => ipcRenderer.invoke('ai:open-settings'),
  // 卖货台：把发布包（文案/首图/配图）落到本地文件夹
  ecomExport: (payload) => ipcRenderer.invoke('ecom:export', payload || {}),
  ecomShow: (dir) => ipcRenderer.invoke('ecom:show', String(dir || '')),

  // 知识库：建库 / 导入文件夹 / 检索 / 问答
  openKb: () => ipcRenderer.invoke('kb:open'),
  kbLoad: () => ipcRenderer.invoke('kb:load'),
  kbSave: (patch) => ipcRenderer.invoke('kb:save', patch || {}),
  kbPickDir: () => ipcRenderer.invoke('kb:pick-dir'),
  kbPickFiles: () => ipcRenderer.invoke('kb:pick-files'),
  kbScan: (dir) => ipcRenderer.invoke('kb:scan', { dir: String(dir || '') }),
  kbAddDocs: (payload) => ipcRenderer.invoke('kb:add-docs', payload || {}),
  kbSearch: (payload) => ipcRenderer.invoke('kb:search', payload || {}),
  kbAsk: (payload) => ipcRenderer.invoke('kb:ask', payload || {}),
  kbDocText: (id) => ipcRenderer.invoke('kb:doc-text', String(id || '')),
  kbDocRemove: (ids) => ipcRenderer.invoke('kb:doc-remove', { ids: Array.isArray(ids) ? ids : [ids] }),
  kbReveal: (p) => ipcRenderer.invoke('kb:reveal', String(p || '')),
  // 拖拽导入：把 DataTransfer 里的 File 换成真实磁盘路径（Electron 32+ 只能用 webUtils）
  pathForFile: (file) => { try { return webUtils.getPathForFile(file) || ''; } catch (e) { return ''; } },
  kbPaths: (paths) => ipcRenderer.invoke('kb:paths', { paths: Array.isArray(paths) ? paths : [] }),

  // 环境 / 迁移（换电脑、换客户、多台机器）
  envInfo: () => ipcRenderer.invoke('env:info'),
  envCheck: () => ipcRenderer.invoke('env:check'),
  envExport: () => ipcRenderer.invoke('env:export'),
  envPick: () => ipcRenderer.invoke('env:pick'),
  envImport: (mode) => ipcRenderer.invoke('env:import', mode),
  envRewrite: (from, to) => ipcRenderer.invoke('env:rewrite', { from, to }),
  envSetDataRoot: (dir, move) => ipcRenderer.invoke('env:set-dataroot', { dir, move }),
  envBuildPortable: () => ipcRenderer.invoke('env:build-portable'),
  envOpenDataRoot: () => ipcRenderer.invoke('env:open-dataroot'),
  envBrowseDir: () => ipcRenderer.invoke('env:browse-dir'),
  envRelaunch: () => ipcRenderer.invoke('env:relaunch'),
  envAiClear: () => ipcRenderer.invoke('env:ai-clear'),
  openEnv: () => ipcRenderer.invoke('env:open'),
  closeEnv: () => ipcRenderer.invoke('env:close'),

  // 窗口整理
  tileWindows: (projectId) => ipcRenderer.invoke('win:tile', projectId),

  // 信任中心（双方共用的台面：确认 / 验收 / 人 / 安全 / 案例 / 条款）
  openTrust: (tab) => ipcRenderer.invoke('trust:open', tab),
  closeTrust: () => ipcRenderer.invoke('trust:close'),
  trustInfo: () => ipcRenderer.invoke('trust:info'),
  trustPreview: (kind, projectId, meta) => ipcRenderer.invoke('trust:preview', { kind, projectId, meta }),
  trustExport: (kind, projectId, meta) => ipcRenderer.invoke('trust:export', { kind, projectId, meta }),
  trustSaveCase: (projectId, patch) => ipcRenderer.invoke('trust:save-case', { projectId, patch }),
  trustTemplate: (id) => ipcRenderer.invoke('trust:template', id),
  trustExportTemplate: (id) => ipcRenderer.invoke('trust:export-template', id),
  trustOpenDocs: () => ipcRenderer.invoke('trust:open-docs'),
  trustAck: (payload) => ipcRenderer.invoke('trust:ack', payload),
  trustAckDigest: (projectId) => ipcRenderer.invoke('trust:ack-digest', projectId),

  // 推进（人）：已并入信任中心「人与角色」页，这里保留旧接口名避免老调用报错
  openAdopt: () => ipcRenderer.invoke('adopt:open'),
  closeAdopt: () => ipcRenderer.invoke('adopt:close'),
  adoptInfo: () => ipcRenderer.invoke('adopt:info'),
  adoptSave: (projectId, patch) => ipcRenderer.invoke('adopt:save', { projectId, patch }),
  adoptSaveStakeholder: (projectId, st) => ipcRenderer.invoke('adopt:save-stakeholder', { projectId, st }),
  adoptDelStakeholder: (projectId, id) => ipcRenderer.invoke('adopt:del-stakeholder', { projectId, id }),
  adoptPreview: (kind, projectId) => ipcRenderer.invoke('adopt:preview', { kind, projectId }),
  adoptExport: (kind, projectId) => ipcRenderer.invoke('adopt:export', { kind, projectId }),

  // 订阅（白名单）
  on: (channel, cb) => {
    if (!ALLOWED_CHANNELS.includes(channel)) return;
    ipcRenderer.on(channel, (e, payload) => cb(payload));
  }
});
