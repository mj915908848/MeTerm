export type Language = 'en' | 'zh';

export interface Translations {
  settingsGroupGeneral: string;
  settingsGroupImportExport: string;
  settingsGroupFmDisplay: string;
  settingsGroupFmOpen: string;
  terminalThemeDark: string;
  terminalThemeDarkHint: string;
  terminalThemeLight: string;
  terminalThemeLightHint: string;
  terminalThemeNb: string;
  terminalThemeNbHint: string;
  uiFontHint: string;
  opacityHint: string;
  vibrancyHint: string;
  backgroundImageHint: string;
  backgroundImageStrength: string;
  aiBarOpacityHint: string;
  fontSizeHint: string;
  cjkFontHint: string;
  fontFeatureHint: string;
  fontSharpnessHint: string;
  defaultShellHint: string;
  encodingHint: string;
  terminalNotificationsHint: string;
  fileLinkConfirmHint: string;
  fileManagerPositionHint: string;
  fileOpenPreferenceSetting: string;
  fileOpenPreferenceHint: string;
  autoNewSessionHint: string;
  rememberWindowSizeHint: string;
  sshTabTitleHint: string;
  enableThumbnailHint: string;
  previewRefreshRateHint: string;
  pipScaleHint: string;
  pipScaleByScreenHint: string;
  contextMenuIntegrationMac: string;
  contextMenuIntegrationWin: string;
  autoOpenAiOnConnectHint: string;
  sshSavedConnectionsHint: string;
  appName: string;
  connectionSort: string;
  connectionSortDefault: string;
  connectionSortIpAsc: string;
  connectionSortIpDesc: string;
  connectionSortNameAsc: string;
  connectionSortNameDesc: string;
  sshTabTitleMode: string;
  autoOpenAiOnConnect: string;
  autoRestoreAiHistoryOnConnect: string;
  sshTabTitleConnection: string;
  sshTabTitleTerminal: string;

  settings: string;
  settingsTabAppearance: string;
  settingsTabTerminal: string;
  settingsTabGeneral: string;
  settingsPageAppearance: string;
  settingsPageTerminal: string;
  settingsPageFileManager: string;
  settingsPageTabsWindows: string;
  settingsPageConnections: string;
  settingsGroupTheme: string;
  settingsGroupBackground: string;
  settingsGroupFont: string;
  settingsGroupShell: string;
  settingsGroupTerminalBehavior: string;
  settingsGroupTabs: string;
  settingsGroupWindow: string;
  settingsGroupPip: string;
  settingsGroupSystem: string;
  settingsGroupOnConnect: string;
  settingsSearchPlaceholder: string;
  settingsSearchNoResults: string;
  opacity: string;
  enableVibrancy: string;
  fontSize: string;
  fontFamily: string;
  uiFontFamily: string;
  cjkFontFamily: string;
  cjkFontAuto: string;
  enableNerdFont: string;
  enableLigatures: string;
  fontWeight: string;
  fontSharpness: string;
  encoding: string;
  fileManagerFontSize: string;
  enableThumbnail: string;
  previewRefreshRate: string;
  previewRate100: string;
  previewRate500: string;
  previewRate1000: string;
  previewRate2000: string;
  previewRate5000: string;
  fileManagerPosition: string;
  fileManagerPositionDrawer: string;
  fileManagerPositionSidebar: string;
  newTerminal: string;
  noSessions: string;
  newSessionHint: string;
  connecting: string;
  connected: string;
  reconnecting: string;
  ended: string;
  sessionNotFound: string;
  disconnected: string;
  statusLocal: string;
  statusError: string;
  statusPaneLabel: string;
  statusPaneTitle: string;
  statusTransferFiles: string;
  statusTransferFile: string;
  statusTransferDone: string;
  statusTooltipStatus: string;
  statusTooltipLatency: string;
  statusTooltipSessions: string;
  statusStartFailed: string;
  reconnect: string;
  active: string;
  language: string;
  closeSession: string;
  contextMenuNewTerminal: string;
  contextMenuHome: string;
  contextMenuSettings: string;
  contextMenuCloseSession: string;
  contextMenuCopy: string;
  contextMenuPaste: string;
  responseSession: string;
  hideToTrayTipTitle: string;
  hideToTrayTipBody: string;
  hideToTrayTipDontShow: string;
  hideToTrayTipOk: string;
  hideToTrayTipHideNow: string;
  hideToTrayTipCancel: string;
  hideToTrayTipRemember: string;
  confirmQuitWithSessions: string;
  confirmCloseAllSessions: string;
  confirmCloseWindowWithSessions: string;
  confirmQuitAllWindows: string;
  confirmHideToTrayWithSessions: string;
  aboutDialogTitle: string;
  aboutDialogBody: string;
  shortcutsDialogTitle: string;
  shortcutsDialogBody: string;
  shortcutNewTerminal: string;
  shortcutCloseSession: string;
  shortcutClearTerminal: string;
  shortcutClearInput: string;
  shortcutOpenSettings: string;
  shortcutSplitHorizontal: string;
  shortcutSplitVertical: string;
  shortcutNavigatePanes: string;
  shortcutSwitchToTab: string;
  shortcutNextTab: string;
  shortcutPrevTab: string;
  colorScheme: string;
  colorSchemeAuto: string;
  colorSchemeDark: string;
  colorSchemeDarker: string;
  colorSchemeNavy: string;
  colorSchemeLight: string;
  colorSchemeNeoBrutalism: string;
  colorSchemeNeoBrutalismRounded: string;
  nbPaletteTitle: string;
  nbBg: string;
  nbText: string;
  nbBorder: string;
  nbShadow: string;
  nbAccent: string;
  nbHighlight: string;
  nbSuccess: string;
  nbInfo: string;
  nbDanger: string;
  nbSurfaceAlt: string;
  nbReset: string;
  nbPresetSunset: string;
  nbPresetOcean: string;
  nbPresetSakura: string;
  nbPresetForest: string;
  nbPresetLavender: string;
  nbPresetMidnight: string;
  nbPresetCyber: string;
  nbPresetAbyss: string;
  nbPresetCandy: string;
  nbPresetRetro: string;
  nbPresetNord: string;
  nbPresetDracula: string;
  nbPresetSolarized: string;
  nbPresetOnyx: string;
  nbPresetEmber: string;
  nbPresetMatrix: string;
  nbPresetStealth: string;
  nbPresetMocha: string;
  rememberWindowSize: string;
  rememberDrawerLayout: string;
  pipScale: string;
  pipScaleByScreen: string;
  sessionsGallery: string;
  sshConnect: string;
  sshHost: string;
  sshPort: string;
  sshUsername: string;
  sshAuthMethod: string;
  sshPassword: string;
  sshPrivateKey: string;
  sshConnectBtn: string;
  sshDisconnect: string;
  sshConnecting: string;
  sshConnected: string;
  sshFailed: string;
  sshAuthPassword: string;
  sshAuthKey: string;
  sshSavedConnections: string;
  sshNoSavedConnections: string;
  sshQuickConnect: string;
  sshNewConnection: string;
  sshDeleteConnection: string;
  sshConnectionName: string;
  sshSaveConnection: string;
  sshTestConnection: string;
  sshProxy: string;
  advancedOptions: string;
  sshProxyType: string;
  sshProxyNone: string;
  sshProxyHost: string;
  sshProxyPort: string;
  sshProxyUsername: string;
  sshProxyPassword: string;
  sshTestSuccess: string;
  sshTestFailed: string;
  sshTesting: string;
  sshConnectAndSave: string;
  sshUnsavedConfirm: string;
  sshUnsavedDiscard: string;
  sshUnsavedCancel: string;
  sshAuthFailedTitle: string;
  sshAuthFailedMsg: string;
  sshAuthFailedRetry: string;
  sshPasswordUpdated: string;
  sshKeyBrowse: string;
  sshKeyBrowseTitle: string;
  sshKeyPlaceholderDefault: string;
  sshKeyPlaceholderAuto: string;
  sshKeyPlaceholderAgent: string;
  sshAgentBadge: string;
  sshAgentBadgeHint: string;
  sshUseDesktopKeyLadder: string;
  sshKeySourceRequired: string;
  sshAuthUsedAgentTitle: string;
  sshAuthUsedAgentBody: string;
  sshAuthUsedDefaultTitle: string;
  sshAuthUsedDefaultBody: string;
  drawerTabFiles: string;
  // File sidebar
  sidebarRefresh: string;
  sidebarNewFolder: string;
  sidebarUpload: string;
  sidebarToggleHidden: string;
  sidebarLockRoot: string;
  sidebarUnlockRoot: string;
  sidebarSwitchView: string;
  sidebarNewFolderPrompt: string;
  sidebarItems: string;
  sidebarInfoDirs: string;
  sidebarInfoFiles: string;
  sidebarMoveTitle: string;
  sidebarMoveConfirm: string;
  sidebarMoveCancel: string;
  sidebarMoveDest: string;
  sidebarEmptyDir: string;
  sidebarTreeMore: string;
  fileManager: string;
  ctxMenuOpen: string;
  ctxMenuSetAsRoot: string;
  ctxMenuOpenWith: string;
  ctxMenuBuiltinEditor: string;
  ctxMenuSystemDefault: string;
  ctxMenuDownloadN: string;
  ctxMenuDownloadFolder: string;
  ctxMenuDownload: string;
  ctxMenuUpload: string;
  ctxMenuUploadToFolder: string;
  ctxMenuUploadToCurrent: string;
  ctxMenuNewFile: string;
  ctxMenuNewFolder: string;
  ctxMenuCopyPath: string;
  ctxMenuCopyAbsPath: string;
  ctxMenuTerminalOps: string;
  ctxMenuCopyTo: string;
  ctxMenuCopyToN: string;
  ctxMenuMoveTo: string;
  ctxMenuMoveToN: string;
  ctxMenuSymlink: string;
  ctxMenuChmod: string;
  ctxMenuRename: string;
  ctxMenuDelete: string;
  ctxMenuDeleteN: string;
  ctxMenuProperties: string;
  ctxMenuMore: string;
  ctxMenuView: string;
  ctxMenuBookmark: string;
  ctxMenuRefresh: string;
  ctxMenuShowHidden: string;
  serverInfoToggle: string;
  serverInfoHost: string;
  serverInfoUser: string;
  serverInfoOS: string;
  serverInfoKernel: string;
  serverInfoUptime: string;
  serverInfoLoad: string;
  serverInfoCPU: string;
  serverInfoMemory: string;
  serverInfoSwap: string;
  serverInfoProcesses: string;
  serverInfoDisk: string;
  serverInfoNetwork: string;
  serverInfoLoading: string;
  serverInfoPanelClose: string;
  serverInfoCores: string;
  serverInfoResources: string;
  serverInfoSwapOff: string;
  connectionsWindowTitle: string;
  connectionsWindowHint: string;
  connectionsWindowSettings: string;
  connectionsWindowOpenFailed: string;
  connectionMoveToGroup: string;
  connectionClearSelection: string;
  connectionGroupEmptyHint: string;
  connectionDeleteFailedTitle: string;
  connectionDeleteFailedBody: string;
  toolbarAiAgent: string;
  toolbarHome: string;
  toolbarAlwaysOnTop: string;
  toolbarUnpinFromTop: string;
  toolbarPictureInPicture: string;
  toolbarExitPictureInPicture: string;
  windowMinimize: string;
  windowMaximize: string;
  windowRestore: string;
  windowClose: string;
  appMenuTitle: string;
  appMenuNewWindow: string;
  appMenuImportConnections: string;
  appMenuExportConnections: string;
  appMenuCloseAllSessions: string;
  appMenuCloseWindow: string;
  appMenuQuit: string;
  processColCommand: string;
  processColCPU: string;
  processColMem: string;
  backgroundImage: string;
  backgroundImageSelect: string;
  backgroundImageClear: string;
  homeNewLocalSession: string;
  homeNewSSHSession: string;
  noShellsFound: string;
  defaultShell: string;
  defaultShellSetting: string;
  contextMenuIntegration: string;
  systemDefault: string;
  homeSavedConnections: string;
  homeEditConnection: string;
  homeShowMore: string;
  homeShowLess: string;
  homeRecentConnections: string;
  aiCapsule: string;
  aiBarOpacity: string;
  aiSendCommand: string;
  aiSendPrompt: string;
  aiModelSelect: string;
  aiPlaceholderInput: string;
  aiPlaceholderCmd: string;
  aiPlaceholderAgent: string;
  aiCollapse: string;
  aiExpand: string;
  aiLayoutSide: string;
  aiLayoutBottom: string;
  aiHistory: string;
  aiHistoryEmpty: string;
  aiSearchHistory: string;
  aiSearchChatHistory: string;
  aiSourceManual: string;
  aiTimeJustNow: string;
  aiCopyCommand: string;
  settingsTabAI: string;
  aiProvider: string;
  aiGroupProviders: string;
  aiGroupReply: string;
  aiGroupAgent: string;
  aiGroupWebSearch: string;
  aiGroupChatHistory: string;
  aiGroupHostNotes: string;
  aiHostNotesNone: string;
  aiHostNotesHint: string;
  aiHostNotesLocal: string;
  aiHostNotesDelete: string;
  aiHostNotesDeleteConfirm: string;
  aiHostNotesUpdated: string;
  aiHostNotesBtnTitle: string;
  aiHostNotesPlaceholder: string;
  aiHostNotesNoHost: string;
  aiHostNotesManage: string;
  aiHostNotesLoaded: string;
  aiSaveChatHistory: string;
  aiSaveChatHistoryHint: string;
  aiChatHistoryLimit: string;
  aiChatHistoryLimitHint: string;
  aiChatHistoryLimitAll: string;
  aiGroupAdvanced: string;
  aiAdvancedSummary: string;
  aiPreset: string;
  aiApiKey: string;
  aiBaseUrl: string;
  aiModelName: string;
  aiTemperature: string;
  aiTemperatureHint: string;
  aiMaxTokens: string;
  aiMaxTokensHint: string;
  aiContextLines: string;
  aiContextLinesHint: string;
  aiHistoryBudget: string;
  aiHistoryBudgetHint: string;
  aiEnableThinking: string;
  aiEnableThinkingHint: string;
  aiThinkingBudget: string;
  aiThinkingBudgetHint: string;
  aiThinkingBudgetDefault: string;
  aiThinkingBudgetLow: string;
  aiThinkingBudgetMedium: string;
  aiThinkingBudgetHigh: string;
  aiThinkingOn: string;
  aiThinkingOff: string;
  aiAgentMaxIterations: string;
  aiAgentUnlimited: string;
  aiPermissionMode: string;
  aiPermissionModeAsk: string;
  aiPermissionModeAcceptSafe: string;
  aiPermissionModeAcceptAll: string;
  aiPermissionModePlan: string;
  aiPermissionModeBypass: string;
  aiPermissionModeHint: string;
  aiPermissionModeChanged: string;
  aiPermissionRules: string;
  aiPermissionRulesAdd: string;
  aiPermissionRulesNone: string;
  aiPermissionActionAllow: string;
  aiPermissionActionDeny: string;
  aiPermissionActionAsk: string;
  aiPermissionRuleTool: string;
  aiPermissionRuleCmdMatch: string;
  aiPermissionRulePathMatch: string;
  aiPermissionRuleRegexInvalid: string;
  aiPermissionRuleSave: string;
  aiPermissionRuleCancel: string;
  aiPermissionRuleToolRequired: string;
  aiAuditLog: string;
  aiAuditLogOpen: string;
  aiAuditLogEmpty: string;
  aiAuditLogClose: string;
  aiAuditLogClear: string;
  aiAuditLogReload: string;
  aiAuditLogClearConfirm: string;
  aiNotifyWaitingTitle: string;
  aiNotifyCompleteTitle: string;
  aiNotifyCompleteBody: string;
  aiNotifyErrorTitle: string;
  aiNotifyErrorBody: string;
  aiTestConnection: string;
  aiTestSuccess: string;
  aiTestFailed: string;
  aiTesting: string;
  aiNewChat: string;
  aiClearChat: string;
  aiRunCommand: string;
  aiCopyCode: string;
  aiCopyResponse: string;
  aiCopyFailed: string;
  aiDangerConfirmTitle: string;
  aiDangerConfirmMsg: string;
  aiDangerConfirmRun: string;
  aiDangerConfirmCancel: string;
  aiNoConfig: string;
  aiStreamError: string;
  aiRateLimitRetry: string;
  aiServerErrorRetry: string;
  aiNetworkRetry: string;
  aiContextCompressed: string;
  aiContextCompressedOverflow: string;
  aiThinking: string;
  aiWorking: string;
  aiStopGenerating: string;
  aiSendToAgentConfirm: string;
  aiSendToAgentDontAsk: string;
  aiSendToAgentYes: string;
  aiSendToAgentNo: string;
  aiPlaceholderAgentMode: string;
  aiCtxCopy: string;
  aiCtxCopyResult: string;
  aiCtxResend: string;
  aiCtxDelete: string;
  aiModelAuto: string;
  aiModelAutoDesc: string;
  aiAddProvider: string;
  aiDeleteProvider: string;
  aiProviderProtocol: string;
  aiFetchModels: string;
  aiFetching: string;
  aiFetchSuccess: string;
  aiFetchFailed: string;
  aiNoModels: string;
  aiModelsCount: string;
  aiSelectModels: string;
  aiProviderLabel: string;
  aiCustomProvider: string;
  aiProviderKeySaved: string;
  aiProviderNoKey: string;
  aiProviderModelsEnabled: string;
  aiProviderNoModelsEnabled: string;
  aiProviderEdit: string;
  aiProviderDone: string;
  aiSearxng: string;
  aiSearxngUrl: string;
  aiSearxngUrlPlaceholder: string;
  aiSearxngAuth: string;
  aiSearxngUsername: string;
  aiSearxngPassword: string;
  aiSearxngEnable: string;
  aiSearxngEnableHint: string;
  aiSearxngTest: string;
  aiSearxngTestOk: string;
  aiSearxngTestFail: string;
  tabMenuCloseTab: string;
  tabMenuCloseOthers: string;
  tabMenuCloseLeft: string;
  tabMenuCloseRight: string;
  tabMenuCloseAll: string;
  tabMenuCopyTitle: string;
  tabMenuCloneTab: string;
  splitHorizontal: string;
  splitVertical: string;
  closePane: string;
  pairingToken: string;
  homeMobilePairing: string;
  masterRequestTitle: string;
  masterRequestMessage: string;
  masterRequestApprove: string;
  masterRequestDeny: string;
  reclaimControl: string;
  reclaimClickHint: string;
  reclaimSpaceHint: string;
  shareLink: string;
  shareLinkCopied: string;
  settingsTabAbout: string;
  aboutVersion: string;
  aboutDescription: string;
  aboutGitHub: string;
  aboutGitee: string;
  aboutLicense: string;
  aboutCopyright: string;
  aboutCheckUpdate: string;
  aboutOpenSource: string;
  aboutLicenses: string;
  aboutAckXterm: string;
  aboutAckTauri: string;
  aboutAckConpty: string;
  aboutAckJumpserver: string;
  aboutAckTldr: string;
  aboutAckSearxng: string;
  aboutAckCodemirror: string;
  sshExportConnections: string;
  sshImportConnections: string;
  sshExportSuccess: string;
  sshExportFailed: string;
  sshImportSuccess: string;
  sshImportFailed: string;
  sshImportInvalidFormat: string;
  sshImportCount: string;
  sshExportCount: string;
  sshExportMissingCredential: string;
  sshExportMobileUnsupported: string;
  sshNoConnectionsToExport: string;
  remoteSecureTransportRequired: string;
  remoteScanComingSoon: string;
  remoteSessionAutoRefresh: string;
  remoteDeleteConnection: string;
  sshHostKeyUnknownTitle: string;
  sshHostKeyUnknownMsg: string;
  sshHostKeyType: string;
  sshHostKeyFingerprint: string;
  sshHostKeyTrust: string;
  sshHostKeyMismatchMsg: string;
  remotePairing: string;
  remotePairApproved: string;
  remotePairDenied: string;
  remotePairTimeout: string;
  remoteScanBtn: string;
  remoteScanStop: string;
  customToken: string;
  kickSuccess: string;
  deviceCardKickDevice: string;
  kickDeviceConfirm: string;
  kickDeviceSuccess: string;
  kickedByHost: string;
  kickedOverlayMsg: string;
  closeTab: string;
  confirmBanIp: string;
  banIpYes: string;
  enableTerminalNotifications: string;
  jsBypassProxy: string;
  remoteTypeBadge: string;
  aiChatHistory: string;
  aiChatHistoryEmpty: string;
  aiChatHistoryTitle: string;
  aiChatDeleteConfirmTitle: string;
  aiChatDeleteConfirmMsg: string;
  aiChatDeleteConfirmOk: string;
  aiChatDeleteConfirmCancel: string;
  aiChatDeleteNoAskMinutes: string;
  aiChatHistoryBack: string;
  aiChatHostUnbound: string;
  aiChatHostLocal: string;
  aiChatHostMismatchTitle: string;
  aiChatHostMismatch: string;
  aiChatOpenElsewhereTitle: string;
  transferStatusPending: string;
  transferStatusInProgress: string;
  transferStatusCompleted: string;
  transferStatusFailed: string;
  transferStatusPaused: string;
  transferStatusCancelled: string;
  transferPause: string;
  transferResume: string;
  transferCancel: string;
  transferDeleteRecord: string;
  transferRevealIn: string;
  transferEmpty: string;
  transferNoMatch: string;
  transferInterrupted: string;
  transferList: string;
  transferFilterUpload: string;
  transferFilterDownload: string;
  transferFilterActive: string;
  transferClearHistory: string;
  transferNotConnected: string;
  aiChatHistoryLoadFailed: string;
  aiChatMessageCount: string;
  aiChatOpenElsewhere: string;
  aiChatPreviewAriaLabel: string;
  aiChatPreviewNoticeBound: string;
  aiChatPreviewNoticeUnbound: string;
  aiChatPreviewBack: string;
  aiChatPreviewClose: string;
  aiChatCopyConversation: string;
  aiChatCopyFailed: string;
  aiChatBindCurrentHost: string;
  aiChatBindConfirmBody: string;
  aiChatBindConfirmTitle: string;
  aiChatBindSuccessNotice: string;
  aiChatBindSuccessStatus: string;
  aiChatBindFailedStatus: string;
  aiChatHistoryImageAlt: string;
  aiChatHistorySearchPlaceholder: string;
  aiChatScopeCurrent: string;
  aiChatScopeAll: string;
  aiAttachBtnTitle: string;
  aiAttachRemoveImage: string;
  aiAttachRemoveFile: string;
  aiAttachImageChip: string;
  aiAttachImageFilter: string;
  aiAttachImageRejected: string;
  aiAttachImageReadFailed: string;
  aiAttachImageUnsupported: string;
  aiAttachImageTooMany: string;
  aiAttachImageTooLarge: string;
  aiAttachImagesTooLarge: string;
  aiAttachImageStillTooLarge: string;
  aiAttachLimitTitle: string;
  aiAttachLimitBody: string;
  aiAttachEmptyTitle: string;
  aiAttachEmptyBody: string;
  aiAttachTooLargeTitle: string;
  aiAttachTooLargeBody: string;
  aiAttachCapError: string;
  aiAttachDuplicateTitle: string;
  aiAttachDuplicateBody: string;
  aiAttachFailedTitle: string;
  aiAttachSaveFailedBody: string;
  aiAttachFailedBody: string;
  aiAttachDirTitle: string;
  aiAttachDirBody: string;
  aiAttachNotFoundTitle: string;
  aiAttachNotFoundBody: string;
  aiImageLightboxClose: string;
  aiBarHide: string;
  aiBarShow: string;
  aiModelNone: string;
  aiPaneBadge: string;
  aiPaneSentFrom: string;
  aiPaneCrossCall: string;
  aiPaneDefaultTarget: string;
  aiTransferWaiting: string;
  aiTransferCancel: string;
  aiTransferCompleted: string;
  aiConfirmReject: string;
  aiConfirmEdit: string;
  aiConfirmAllOccurrences: string;
  aiConfirmMoreChars: string;
  aiWaitDefaultReason: string;
  commonCopied: string;
  updateAvailable: string;
  updateNow: string;
  updateLater: string;
  updateDownloading: string;
  updateFinishing: string;
  updateRestarting: string;
  updateHint: string;
  updateFailed: string;
  updateFailedHint: string;
  updateModalTitle: string;
  updateReleaseNotes: string;
  checkUpdates: string;
  checkUpdatesUpToDate: string;
  checkUpdatesChecking: string;
  updateModalClose: string;
  hideUpdateIcon: string;
  openFileManager: string;
  navigateConfirmMsg: string;
  navigateCancel: string;
  navigateConfirm: string;
  fileLinkHint: string;
  fileLinkOpenLocal: string;
  fileLinkOpenInDrawer: string;
  fileLinkDontAskAgain: string;
  fileLinkLocalConfirmMsg: string;
  fileLinkConfirmOpen: string;
  fileLinkSkipConfirmSetting: string;
  autoNewSession: string;
  // tldr & command completion
  tldrHelp: string;
  tldrEnable: string;
  tldrNoData: string;
  tldrUpdating: string;
  tldrLastUpdated: string;
  tldrUpdateNow: string;
  tldrPageCount: string;
  tldrExamples: string;
  cmdCompletionEnable: string;
  cmdCompletionHint: string;
  // Shell hook injection
  shellHookEnable: string;
  shellHookHint: string;
  settingsGroupCommandAssist: string;
  // JumpServer
  jsEditServer: string;
  jsAddServer: string;
  jsName: string;
  jsBaseUrl: string;
  jsSshHost: string;
  jsSshHostPlaceholder: string;
  jsAuthMethod: string;
  jsAuthPassword: string;
  jsAuthToken: string;
  jsApiToken: string;
  jsOrgId: string;
  jsOrgIdPlaceholder: string;
  jsTestConnection: string;
  jsTesting: string;
  jsTestSuccess: string;
  jsTestFailed: string;
  jsSave: string;
  jsFieldsRequired: string;
  jsInvalidUrl: string;
  jsMfaTitle: string;
  jsMfaDesc: string;
  jsMfaCodePlaceholder: string;
  jsMfaVerify: string;
  jsAssetBrowser: string;
  jsSearchAssets: string;
  jsLoading: string;
  jsAllAssets: string;
  jsAssetsTotal: string;
  jsNoAssets: string;
  jsAssetName: string;
  jsAssetAddress: string;
  jsAssetPlatform: string;
  jsAssetComment: string;
  jsAssetProtocols: string;
  jsAssetActions: string;
  jsConnect: string;
  jsConnectingAuth: string;
  jsConnectingToken: string;
  jsConnectingAsset: string;
  jsLoadingAccounts: string;
  jsNoAccounts: string;
  jsSelectAccount: string;
  // ── JumpServer session expiration / logout ──
  jsSessionExpired: string;
  jsSessionExpiredDesc: string;
  jsReconnectAction: string;
  jsLogoutAction: string;
  jsLogoutConfirm: string;
  jsLoginRequired: string;
  jsReloginFailed: string;
  jsItemActionsTitle: string;
  jsCredentialPromptTitle: string;
  jsCredentialPromptDesc: string;
  jsCredentialPromptUsername: string;
  jsCredentialPromptPassword: string;
  jsCredentialPromptApiToken: string;
  jsCredentialPromptSubmit: string;
  jsCredentialStoredHint: string;
  jsCredentialAuthorityChanged: string;
  jsReturnToMainWindow: string;
  homeNewJumpServer: string;
  jsSaveAndConnect: string;
  homeSearchPlaceholder: string;
  homeGroupDefault: string;
  homeGroupUngrouped: string;
  homeGroupManage: string;
  homeGroupNew: string;
  homeGroupRename: string;
  homeGroupDelete: string;
  homeGroupDeleteConfirm: string;
  homeGroupMoveToGroup: string;
  homeGroupNodeCount: string;
  homeGroupResizeHint: string;
  homeGroupColor: string;
  homeGroupColorClear: string;
  homeGroupCollapse: string;
  homeGroupExpand: string;
  homeGroupDuplicate: string;
  homeGroupNewName: string;
  homeGroupNameReserved: string;
  homeRecentActivity: string;
  homeRecentRemove: string;
  homeFooterVersion: string;
  homeFooterGitHub: string;
  homeNoConnections: string;
  homeSearchHint: string;
  homeSearchConnections: string;
  homeSearchWeb: string;
  homeSearchTldr: string;
  homeSearching: string;
  homeSearchLoadMore: string;
  homeSearchPerPage: string;
  homeNoResults: string;
  editorLargeFileWarning: string;
  editorLargeFileTitle: string;
  editorUnsavedChanges: string;
  editorSaving: string;
  editorSaved: string;
  editorSaveFailed: string;
  editorDisconnected: string;
  editorReadOnly: string;
  editorLoading: string;
  editorMdPreview: string;
  editorMdPreviewOff: string;
  editorWordWrap: string;
  editorCut: string;
  editorCopy: string;
  editorPaste: string;
  editorSelectAll: string;
  editorSave: string;
  editorCloseTab: string;
  editorFormat: string;
}

const translations: Record<Language, Translations> = {
  en: {
    settingsGroupGeneral: 'General',
    settingsGroupImportExport: 'Import & Export',
    settingsGroupFmDisplay: 'Display',
    settingsGroupFmOpen: 'Opening Files',
    terminalThemeDark: 'Dark Terminal Colors',
    terminalThemeDarkHint: 'Used when the appearance is dark',
    terminalThemeLight: 'Light Terminal Colors',
    terminalThemeLightHint: 'Used when the appearance is light. With Auto, both are used',
    terminalThemeNb: 'Terminal Colors',
    terminalThemeNbHint: 'Set by the Neo-Brutalism appearance',
    uiFontHint: 'Tabs, menus and windows like this one. Does not affect the terminal',
    opacityHint: 'Below 100% the desktop shows through',
    vibrancyHint: 'Blurs the desktop that shows through. No visible effect at 100% window opacity',
    backgroundImageHint: 'Shown behind the terminal',
    backgroundImageStrength: 'Image Strength',
    aiBarOpacityHint: 'Only the AI input bar under the terminal',
    fontSizeHint: 'Also adjustable in the terminal with ⌘/Ctrl + and −',
    cjkFontHint: 'Used for Chinese, Japanese and Korean characters',
    fontFeatureHint: 'Unavailable when the current font does not support it',
    fontSharpnessHint: 'May make scrolling less smooth',
    defaultShellHint: 'Local terminals only. SSH sessions use the server\'s shell',
    encodingHint: 'Applies to every open session at once. Change it only when an old server shows garbled text',
    terminalNotificationsHint: 'Alerts that programs in the terminal send with escape sequences, at most one per session every 3 seconds',
    fileLinkConfirmHint: 'Ask before opening a file path clicked in the terminal',
    fileManagerPositionHint: 'Bottom drawer or left sidebar. Can also be switched inside the file manager',
    fileOpenPreferenceSetting: 'Double-clicking text and image files',
    fileOpenPreferenceHint: 'Remote files are downloaded first when opened with a system app',
    autoNewSessionHint: 'When off, the app opens on the home page',
    rememberWindowSizeHint: 'Including whether it was maximized',
    sshTabTitleHint: 'The connection name, or the title programs on the server set',
    enableThumbnailHint: 'Adds a Session Overview button to the toolbar that shows every session as a thumbnail',
    previewRefreshRateHint: 'Shorter is more live and uses more power',
    pipScaleHint: 'Size of the PiP window relative to the original',
    pipScaleByScreenHint: 'When off, relative to the main window',
    contextMenuIntegrationMac: 'Add "Open in MeTerm" to the Finder context menu',
    contextMenuIntegrationWin: 'Add "Open in MeTerm" to the Explorer context menu',
    autoOpenAiOnConnectHint: 'After an SSH connection succeeds',
    sshSavedConnectionsHint: 'Exported files contain passwords and private keys in plain text, so you are asked to verify first. Importing replaces connections with the same name',
    appName: 'MeTerm',
    settings: 'Settings',
    settingsTabAppearance: 'Appearance',
    settingsTabTerminal: 'Terminal',
    settingsTabGeneral: 'General',
    settingsPageAppearance: 'Appearance',
    settingsPageTerminal: 'Terminal',
    settingsPageFileManager: 'File Manager',
    settingsPageTabsWindows: 'Tabs & Windows',
    settingsPageConnections: 'Connections',
    settingsGroupTheme: 'Theme',
    settingsGroupBackground: 'Window Background',
    settingsGroupFont: 'Font',
    settingsGroupShell: 'Shell & Encoding',
    settingsGroupTerminalBehavior: 'Behavior',
    settingsGroupTabs: 'Tabs',
    settingsGroupWindow: 'Startup & Window',
    settingsGroupPip: 'Picture in Picture',
    settingsGroupSystem: 'System Integration',
    settingsGroupOnConnect: 'After Connecting',
    settingsSearchPlaceholder: 'Search settings',
    settingsSearchNoResults: 'No matching settings',
    opacity: 'Window Opacity',
    enableVibrancy: 'Background Blur',
    fontSize: 'Font Size',
    fontFamily: 'Font',
    uiFontFamily: 'UI Font',
    cjkFontFamily: 'CJK Font',
    cjkFontAuto: 'System Default',
    enableNerdFont: 'Nerd Font Icons',
    enableLigatures: 'Ligatures',
    fontWeight: 'Font Weight',
    fontSharpness: 'Text Sharpening',
    encoding: 'Encoding',
    fileManagerFontSize: 'Font Size',
    enableThumbnail: 'Session Overview',
    previewRefreshRate: 'Thumbnail Refresh Interval',
    previewRate100: '100ms (Fastest)',
    previewRate500: '500ms (Fast)',
    previewRate1000: '1s (Normal)',
    previewRate2000: '2s (Slow)',
    previewRate5000: '5s (Slowest)',
    fileManagerPosition: 'Position',
    fileManagerPositionDrawer: 'Bottom Drawer',
    fileManagerPositionSidebar: 'Left Sidebar (Tree View)',
    newTerminal: 'New Terminal',
    noSessions: 'No terminal sessions',
    newSessionHint: 'Press ⌘T or click "New Terminal" to create one',
    connecting: 'Connecting',
    connected: 'Connected',
    reconnecting: 'Reconnecting',
    ended: 'Ended',
    sessionNotFound: 'Session not found',
    disconnected: 'Disconnected',
    statusLocal: 'Local',
    statusError: 'Error',
    statusPaneLabel: 'Pane · {total}',
    statusPaneTitle: 'Pane {n} of {total}',
    statusTransferFiles: '{count} files',
    statusTransferFile: '{count} file',
    statusTransferDone: 'Done',
    statusTooltipStatus: 'Status: {value}',
    statusTooltipLatency: 'Latency: {ms}ms',
    statusTooltipSessions: 'Tabs: {count}',
    statusStartFailed: 'Failed to start meterm',
    reconnect: 'Reconnect',
    active: 'Active',
    language: 'Language',
    closeSession: 'Close Session',
    contextMenuNewTerminal: 'New Terminal',
    contextMenuHome: 'Home',
    contextMenuSettings: 'Settings',
    contextMenuCloseSession: 'Close Current Session',
    contextMenuCopy: 'Copy',
    contextMenuPaste: 'Paste',
    responseSession: 'Response Session',
    hideToTrayTipTitle: 'Hide to tray?',
    hideToTrayTipBody: 'Hide the window to system tray? Click the tray icon to reopen.',
    hideToTrayTipDontShow: "Don't show again",
    hideToTrayTipOk: 'Got it',
    hideToTrayTipHideNow: 'Hide now',
    hideToTrayTipCancel: 'Cancel',
    hideToTrayTipRemember: 'Remember this choice?',
    confirmQuitWithSessions: 'There are active sessions. Quit and close all sessions?',
    confirmCloseAllSessions: 'Close all sessions now?',
    confirmCloseWindowWithSessions: 'This window has active sessions. Close window and end all sessions?',
    confirmQuitAllWindows: 'Close all windows and sessions? This will quit the application.',
    confirmHideToTrayWithSessions: 'Active sessions detected. Hide window to tray?',
    aboutDialogTitle: 'About',
    aboutDialogBody: 'A lightweight multi-session terminal client.',
    shortcutsDialogTitle: 'Keyboard Shortcuts',
    shortcutsDialogBody: '',
    shortcutNewTerminal: 'New Terminal',
    shortcutCloseSession: 'Close Current Session',
    shortcutClearTerminal: 'Clear Terminal',
    shortcutClearInput: 'Clear Input Line',
    shortcutOpenSettings: 'Open Settings',
    shortcutSplitHorizontal: 'Split Horizontal',
    shortcutSplitVertical: 'Split Vertical',
    shortcutNavigatePanes: 'Navigate Between Panes',
    shortcutSwitchToTab: 'Switch to Tab 1–8 / Last',
    shortcutNextTab: 'Next Tab',
    shortcutPrevTab: 'Previous Tab',
    colorScheme: 'Appearance',
    colorSchemeAuto: 'Auto (System)',
    colorSchemeDark: 'Dark',
    colorSchemeDarker: 'Midnight',
    colorSchemeNavy: 'Deep Navy',
    colorSchemeLight: 'Light',
    colorSchemeNeoBrutalism: 'Neo-Brutalism',
    colorSchemeNeoBrutalismRounded: 'Neo-Brutalism (Rounded)',
    nbPaletteTitle: 'Neo-Brutalism Palette',
    nbBg: 'Background',
    nbText: 'Text',
    nbBorder: 'Border',
    nbShadow: 'Shadow',
    nbAccent: 'Accent',
    nbHighlight: 'Highlight',
    nbSuccess: 'Success',
    nbInfo: 'Info',
    nbDanger: 'Danger',
    nbSurfaceAlt: 'Surface Alt',
    nbReset: 'Reset Palette',
    nbPresetSunset: '🌅 Sunset',
    nbPresetOcean: '🌊 Ocean',
    nbPresetSakura: '🌸 Sakura',
    nbPresetForest: '🌲 Forest',
    nbPresetLavender: '💜 Lavender',
    nbPresetMidnight: '🌙 Midnight',
    nbPresetCyber: '👾 Cyberpunk',
    nbPresetAbyss: '🌀 Abyss',
    nbPresetCandy: '🍬 Candy',
    nbPresetRetro: '📺 Retro',
    nbPresetNord: '❄️ Nord',
    nbPresetDracula: '🧛 Dracula',
    nbPresetSolarized: '☀️ Solarized',
    nbPresetOnyx: '🖤 Onyx',
    nbPresetEmber: '🔥 Ember',
    nbPresetMatrix: '💚 Matrix',
    nbPresetStealth: '🥷 Stealth',
    nbPresetMocha: '☕ Mocha',
    rememberWindowSize: 'Remember Window Position and Size',
    connectionSort: 'Sort connections',
    connectionSortDefault: 'Default order',
    connectionSortIpAsc: 'IP ascending',
    connectionSortIpDesc: 'IP descending',
    connectionSortNameAsc: 'Name ascending',
    connectionSortNameDesc: 'Name descending',
    sshTabTitleMode: 'SSH tab title',
    autoOpenAiOnConnect: 'Open AI Panel Automatically',
    autoRestoreAiHistoryOnConnect: 'Restore This Host\'s Latest Conversation',
    sshTabTitleConnection: 'Connection name',
    sshTabTitleTerminal: 'Dynamic terminal title',

    rememberDrawerLayout: 'Remember Drawer Height',
    pipScale: 'Scale',
    pipScaleByScreen: 'Relative to Screen Size',
    sessionsGallery: 'Sessions',
    sshConnect: 'SSH Connection',
    sshHost: 'Host',
    sshPort: 'Port',
    sshUsername: 'Username',
    sshAuthMethod: 'Auth Method',
    sshPassword: 'Password',
    sshPrivateKey: 'Private Key Path',
    sshConnectBtn: 'Connect',
    sshDisconnect: 'Disconnect',
    sshConnecting: 'Connecting...',
    sshConnected: 'Connected',
    sshFailed: 'Connection Failed',
    sshAuthPassword: 'Password',
    sshAuthKey: 'Public Key',
    sshSavedConnections: 'Saved Connections',
    sshNoSavedConnections: 'No saved connections',
    sshQuickConnect: 'Quick Connect',
    sshNewConnection: 'New Connection',
    sshDeleteConnection: 'Delete',
    sshConnectionName: 'Connection Name',
    sshSaveConnection: 'Save',
    sshTestConnection: 'Test',
    sshProxy: 'Proxy',
    advancedOptions: 'Advanced Options',
    sshProxyType: 'Proxy Type',
    sshProxyNone: 'Direct',
    sshProxyHost: 'Proxy Host',
    sshProxyPort: 'Port',
    sshProxyUsername: 'Username',
    sshProxyPassword: 'Password',
    sshTestSuccess: 'Connection successful!',
    sshTestFailed: 'Connection failed',
    sshTesting: 'Testing...',
    sshConnectAndSave: 'Connect & Save',
    sshUnsavedConfirm: 'You have unsaved changes. Discard?',
    sshUnsavedDiscard: 'Discard',
    sshUnsavedCancel: 'Cancel',
    sshAuthFailedTitle: 'Authentication Failed',
    sshAuthFailedMsg: 'The saved password may have changed. Please enter the new password for {username}@{host}:',
    sshAuthFailedRetry: 'Reconnect',
    sshPasswordUpdated: 'Password updated and saved.',
    sshKeyBrowse: 'Browse for private key file',
    sshKeyBrowseTitle: 'Select private key',
    sshKeyPlaceholderDefault: '~/.ssh/id_rsa  (leave empty to auto-detect)',
    sshKeyPlaceholderAuto: 'Leave empty to auto-use {path}',
    sshKeyPlaceholderAgent: 'Leave empty to use ssh-agent',
    sshAgentBadge: 'agent: {count}',
    sshAgentBadgeHint: 'ssh-agent is running and exposing this many identities. Leave the key path empty to use them.',
    sshUseDesktopKeyLadder: 'Use this Mac\'s ssh-agent or default ~/.ssh key (requires identity confirmation when saved)',
    sshKeySourceRequired: 'Choose a private key or explicitly enable the desktop ssh-agent/default-key option.',
    sshAuthUsedAgentTitle: 'Connected via ssh-agent',
    sshAuthUsedAgentBody: 'Authentication succeeded using a key from your running ssh-agent.',
    sshAuthUsedDefaultTitle: 'Connected via default key',
    sshAuthUsedDefaultBody: 'Authentication succeeded using a key in ~/.ssh/.',
    drawerTabFiles: 'Files',
    sidebarRefresh: 'Refresh',
    sidebarNewFolder: 'New folder',
    sidebarUpload: 'Upload',
    sidebarToggleHidden: 'Toggle hidden files',
    sidebarLockRoot: 'Unlock to follow terminal directory',
    sidebarUnlockRoot: 'Lock current directory',
    sidebarSwitchView: 'Switch view',
    sidebarNewFolderPrompt: 'Enter folder name:',
    sidebarItems: 'items',
    sidebarInfoDirs: 'folders',
    sidebarInfoFiles: 'files',
    sidebarMoveTitle: 'Move {count} item(s)?',
    sidebarMoveConfirm: 'Move',
    sidebarMoveCancel: 'Cancel',
    sidebarMoveDest: 'Destination',
    sidebarEmptyDir: 'Empty',
    sidebarTreeMore: '{n} more, click to load',
    fileManager: 'File Manager',
    ctxMenuOpen: 'Open',
    ctxMenuSetAsRoot: 'Set as Root',
    ctxMenuOpenWith: 'Open With',
    ctxMenuBuiltinEditor: 'Built-in Editor',
    ctxMenuSystemDefault: 'System Default',
    ctxMenuDownloadN: 'Download {count} Items',
    ctxMenuDownloadFolder: 'Download Folder',
    ctxMenuDownload: 'Download',
    ctxMenuUpload: 'Upload',
    ctxMenuUploadToFolder: 'Upload to This Folder',
    ctxMenuUploadToCurrent: 'Upload to Current Path',
    ctxMenuNewFile: 'New File',
    ctxMenuNewFolder: 'New Folder',
    ctxMenuCopyPath: 'Copy Path',
    ctxMenuCopyAbsPath: 'Copy Absolute Path',
    ctxMenuTerminalOps: 'Terminal Commands',
    ctxMenuCopyTo: 'Copy To...',
    ctxMenuCopyToN: 'Copy {count} Items To...',
    ctxMenuMoveTo: 'Move To...',
    ctxMenuMoveToN: 'Move {count} Items To...',
    ctxMenuSymlink: 'Create Symlink',
    ctxMenuChmod: 'Change Permissions',
    ctxMenuRename: 'Rename',
    ctxMenuDelete: 'Delete',
    ctxMenuDeleteN: 'Delete {count} Items',
    ctxMenuProperties: 'Properties',
    ctxMenuMore: 'More',
    ctxMenuView: 'View',
    ctxMenuBookmark: 'Bookmark Current Directory',
    ctxMenuRefresh: 'Refresh',
    ctxMenuShowHidden: 'Show Hidden Files',
    serverInfoToggle: 'Server Info',
    serverInfoHost: 'Host',
    serverInfoUser: 'User',
    serverInfoOS: 'OS',
    serverInfoKernel: 'Kernel',
    serverInfoUptime: 'Uptime',
    serverInfoLoad: 'Load',
    serverInfoCPU: 'CPU',
    serverInfoMemory: 'Memory',
    serverInfoSwap: 'Swap',
    serverInfoProcesses: 'Processes',
    serverInfoDisk: 'Disk',
    serverInfoNetwork: 'Network',
    serverInfoLoading: 'Loading...',
    serverInfoPanelClose: 'Close',
    serverInfoCores: 'cores',
    serverInfoResources: 'Resources',
    serverInfoSwapOff: 'Off',
    connectionsWindowTitle: 'Connections',
    connectionsWindowHint: 'Click a connection to open it. ⌘/Ctrl-click to select several, then drag them onto a group.',
    connectionsWindowSettings: 'Settings',
    connectionsWindowOpenFailed: 'Could not open the connections window.',
    connectionMoveToGroup: 'Move to group',
    connectionClearSelection: 'Clear',
    connectionGroupEmptyHint: 'Drag connections here',
    connectionDeleteFailedTitle: 'Could not delete connection',
    connectionDeleteFailedBody: 'The connection is still in the list. See the console for details.',
    toolbarAiAgent: 'AI Agent',
    toolbarHome: 'Home',
    toolbarAlwaysOnTop: 'Always on top',
    toolbarUnpinFromTop: 'Unpin from top',
    toolbarPictureInPicture: 'Picture-in-Picture',
    toolbarExitPictureInPicture: 'Exit Picture-in-Picture',
    windowMinimize: 'Minimize',
    windowMaximize: 'Maximize',
    windowRestore: 'Restore',
    windowClose: 'Close',
    appMenuTitle: 'App Menu',
    appMenuNewWindow: 'New Window',
    appMenuImportConnections: 'Import Connections',
    appMenuExportConnections: 'Export Connections',
    appMenuCloseAllSessions: 'Close All Sessions',
    appMenuCloseWindow: 'Close Window',
    appMenuQuit: 'Quit Application',
    processColCommand: 'Command',
    processColCPU: 'CPU%',
    processColMem: 'MEM%',
    backgroundImage: 'Background Image',
    backgroundImageSelect: 'Select Image',
    backgroundImageClear: 'Clear',
    homeNewLocalSession: 'New Local Session',
    homeNewSSHSession: 'New SSH Session',
    noShellsFound: 'No shells found',
    defaultShell: 'default',
    defaultShellSetting: 'Default Shell',
    contextMenuIntegration: 'Add "Open in MeTerm" to context menu',
    systemDefault: 'System Default',
    homeSavedConnections: 'Saved Connections',
    homeEditConnection: 'Edit',
    homeShowMore: 'Show More',
    homeShowLess: 'Show Less',
    homeRecentConnections: 'Recent',
    aiCapsule: 'MeAgent',
    aiBarOpacity: 'AI Input Bar Opacity',
    aiSendCommand: 'Send Command',
    aiSendPrompt: 'Send Prompt',
    aiModelSelect: 'Model',
    aiPlaceholderInput: 'Type a command or prompt...',
    aiPlaceholderCmd: 'Command ',
    aiPlaceholderAgent: ' Ask MeAgent... ',
    aiCollapse: 'Collapse',
    aiExpand: 'Expand',
    aiLayoutSide: 'Sidebar',
    aiLayoutBottom: 'Bottom',
    aiHistory: 'History',
    aiHistoryEmpty: 'No command history',
    aiSearchHistory: 'Search command history...',
    aiSearchChatHistory: 'Search chat history...',
    aiSourceManual: 'Manual',
    aiTimeJustNow: 'just now',
    aiCopyCommand: 'Copy command',
    settingsTabAI: 'AI',
    aiProvider: 'Provider',
    aiGroupProviders: 'Model Services',
    aiGroupReply: 'Replies',
    aiGroupAgent: 'Agent',
    aiGroupWebSearch: 'Web Search',
    aiGroupChatHistory: 'Conversation History',
    aiGroupHostNotes: 'Host Notes',
    aiHostNotesNone: 'No notes yet. When the agent learns something useful about a server (where an app lives, how it is restarted), it saves a note here after you approve it, and uses it the next time you work on that server.',
    aiHostNotesHint: 'The agent sees a host\'s notes whenever it works on that host. One fact per line. Edits save when you leave the box; clearing the text deletes the notes.',
    aiHostNotesLocal: 'This computer',
    aiHostNotesDelete: 'Delete',
    aiHostNotesDeleteConfirm: 'Click again to delete',
    aiHostNotesUpdated: 'Updated {time}',
    aiHostNotesBtnTitle: 'Host notes',
    aiHostNotesPlaceholder: 'Nothing yet. One fact per line, e.g.\napp in /srv/app, restart with systemctl restart app',
    aiHostNotesNoHost: 'Notes need a connected terminal: this pane has no host yet.',
    aiHostNotesManage: 'All hosts…',
    aiHostNotesLoaded: 'Host notes for {host} loaded ({count} lines)',
    aiSaveChatHistory: 'Save Conversations',
    aiSaveChatHistoryHint: 'Keeps AI conversations on this computer so they can be reopened. What the agent types into terminal prompts and screenshots taken by tools are not saved; long command output is shortened.',
    aiChatHistoryLimit: 'Keep',
    aiChatHistoryLimitHint: 'The oldest conversations beyond this are deleted. Conversations open in a tab are kept.',
    aiChatHistoryLimitAll: 'All conversations',
    aiGroupAdvanced: 'Advanced',
    aiAdvancedSummary: 'Temperature, conversation history limit, terminal lines',
    aiPreset: 'Quick Select',
    aiApiKey: 'API Key',
    aiBaseUrl: 'API Base URL',
    aiModelName: 'Model',
    aiTemperature: 'Temperature',
    aiTemperatureHint: 'Higher values give more varied answers. Ignored by Claude Opus 4.7 and later and by OpenAI reasoning models.',
    aiMaxTokens: 'Max reply length',
    aiMaxTokensHint: 'The most tokens the model may write in one reply, thinking included.',
    aiContextLines: 'Terminal lines to include',
    aiContextLinesHint: 'With the shell hook, your last command and its full output are sent with each question. Without it, this many recent lines of the terminal are sent instead.',
    aiHistoryBudget: 'Conversation history limit',
    aiHistoryBudgetHint: 'Older messages are summarized once the conversation grows past this.',
    aiEnableThinking: 'Thinking mode',
    aiEnableThinkingHint: 'Only affects OpenAI-compatible services such as DeepSeek, Qwen (Alibaba Cloud), GLM and MiMo. Claude, OpenAI and Gemini ignore it.',
    aiThinkingBudget: 'Thinking budget',
    aiThinkingBudgetHint: 'Caps the tokens spent thinking before the answer, so thinking cannot use up the reply limit. Applies while thinking mode is on.',
    aiThinkingBudgetDefault: 'Model default',
    aiThinkingBudgetLow: 'Low (4k)',
    aiThinkingBudgetMedium: 'Medium (16k)',
    aiThinkingBudgetHigh: 'High (32k)',
    aiThinkingOn: 'Thinking on',
    aiThinkingOff: 'Thinking off',
    aiPermissionMode: 'Permission mode',
    aiPermissionModeAsk: 'Ask every time',
    aiPermissionModeAcceptSafe: 'Auto-run safe actions',
    aiPermissionModeAcceptAll: 'Auto-run all but dangerous',
    aiPermissionModePlan: 'Plan (read-only)',
    aiPermissionModeBypass: 'Bypass (never ask)',
    aiPermissionModeHint: 'Whether the agent asks before using a tool. The shield button in the AI bar switches the same setting. Plan mode never changes anything; reading sensitive files or files outside the working directory always asks.',
    aiPermissionModeChanged: 'Permission mode: {mode}',
    aiPermissionRules: 'Permission rules',
    aiPermissionRulesAdd: 'Add rule',
    aiPermissionRulesNone: 'No custom rules. Sensitive or out-of-workspace reads require confirmation; Accept safe asks before commands flagged as dangerous.',
    aiPermissionActionAllow: 'Allow',
    aiPermissionActionDeny: 'Deny',
    aiPermissionActionAsk: 'Ask',
    aiPermissionRuleTool: 'Tool',
    aiPermissionRuleCmdMatch: 'Command regex',
    aiPermissionRulePathMatch: 'Path regex',
    aiPermissionRuleRegexInvalid: 'Invalid regular expression. Fix it before saving this rule.',
    aiPermissionRuleSave: 'Save',
    aiPermissionRuleCancel: 'Cancel',
    aiPermissionRuleToolRequired: 'Enter a tool name (* matches all tools).',
    aiAuditLog: 'Activity log',
    aiAuditLogOpen: 'Open',
    aiAuditLogEmpty: '(No audit entries yet)',
    aiAuditLogClose: 'Close',
    aiAuditLogClear: 'Clear log',
    aiAuditLogReload: 'Reload',
    aiAuditLogClearConfirm: 'Clear all audit entries? This cannot be undone.',
    aiNotifyWaitingTitle: 'AI agent needs your attention',
    aiNotifyCompleteTitle: 'AI agent finished',
    aiNotifyCompleteBody: 'The agent turn completed.',
    aiNotifyErrorTitle: 'AI agent stopped with an error',
    aiNotifyErrorBody: 'The agent encountered an unrecoverable error.',
    aiAgentMaxIterations: 'Max steps per run',
    aiAgentUnlimited: 'Unlimited',
    aiTestConnection: 'Test Connection',
    aiTestSuccess: 'Connection successful!',
    aiTestFailed: 'Connection failed',
    aiTesting: 'Testing...',
    aiNewChat: 'New Chat',
    aiClearChat: 'Clear Chat',
    aiRunCommand: 'Run',
    aiCopyCode: 'Copy',
    aiCopyResponse: 'Copy response',
    aiCopyFailed: 'Copy failed — try again',
    aiDangerConfirmTitle: 'Dangerous Command',
    aiDangerConfirmMsg: 'This command may cause irreversible changes. Are you sure you want to run it?',
    aiDangerConfirmRun: 'Run Anyway',
    aiDangerConfirmCancel: 'Cancel',
    aiNoConfig: 'AI not configured. Go to Settings > AI to set up.',
    aiStreamError: 'Request failed',
    aiRateLimitRetry: 'Rate limited, retrying',
    aiServerErrorRetry: 'Server error, retrying',
    aiNetworkRetry: 'Network blip, retrying',
    aiContextCompressed: 'Context compressed to fit model limits',
    aiContextCompressedOverflow: 'Context exceeded the model limit — compressed and retrying',
    aiThinking: 'Thinking',
    aiWorking: 'Working',
    aiStopGenerating: 'Stop',
    aiSendToAgentConfirm: 'This looks like a prompt. Send to MeAgent?',
    aiSendToAgentDontAsk: "Don't ask again, always send to MeAgent",
    aiSendToAgentYes: 'Send to Agent',
    aiSendToAgentNo: 'Send to Terminal',
    aiPlaceholderAgentMode: ' MeAgent ',
    aiCtxCopy: 'Copy',
    aiCtxCopyResult: 'Copy Result',
    aiCtxResend: 'Resend',
    aiCtxDelete: 'Delete',
    aiModelAuto: 'Auto',
    aiModelAutoDesc: 'Use default model for current provider',
    aiAddProvider: 'Add Provider',
    aiDeleteProvider: 'Delete',
    aiProviderProtocol: 'Protocol',
    aiFetchModels: 'Fetch Models',
    aiFetching: 'Fetching...',
    aiFetchSuccess: 'models loaded',
    aiFetchFailed: 'Fetch failed',
    aiNoModels: 'No models. Click "Fetch Models" to load.',
    aiModelsCount: 'models',
    aiSelectModels: 'Select Models',
    aiProviderLabel: 'Name',
    aiCustomProvider: 'Custom',
    aiProviderKeySaved: 'API key saved',
    aiProviderNoKey: 'No API key',
    aiProviderModelsEnabled: '{count} models enabled',
    aiProviderNoModelsEnabled: 'No models enabled',
    aiProviderEdit: 'Edit',
    aiProviderDone: 'Done',
    aiSearxng: 'Web Search (SearXNG)',
    aiSearxngUrl: 'SearXNG URL',
    aiSearxngUrlPlaceholder: 'https://searx.example.org',
    aiSearxngAuth: 'Sign-in',
    aiSearxngUsername: 'Username (optional)',
    aiSearxngPassword: 'Password (optional)',
    aiSearxngEnable: 'Let the agent search the web',
    aiSearxngEnableHint: 'Uses your own SearXNG instance.',
    aiSearxngTest: 'Test',
    aiSearxngTestOk: 'SearXNG connected!',
    aiSearxngTestFail: 'SearXNG connection failed',
    tabMenuCloseTab: 'Close Tab',
    tabMenuCloseOthers: 'Close Other Tabs',
    tabMenuCloseLeft: 'Close Tabs to the Left',
    tabMenuCloseRight: 'Close Tabs to the Right',
    tabMenuCloseAll: 'Close All Tabs',
    tabMenuCopyTitle: 'Copy Tab Title',
    tabMenuCloneTab: 'Clone Tab',
    splitHorizontal: 'Split Horizontal',
    splitVertical: 'Split Vertical',
    closePane: 'Close Pane',
    pairingToken: 'Token',
    homeMobilePairing: 'Mobile Pairing',
    masterRequestTitle: 'Control Request',
    masterRequestMessage: 'A remote viewer wants to take control of the terminal.',
    masterRequestApprove: 'Approve',
    masterRequestDeny: 'Deny',
    reclaimControl: 'Reclaim Control',
    reclaimClickHint: 'Click to reclaim control',
    reclaimSpaceHint: '(Press Space to reclaim)',
    shareLink: 'Copy Share Link',
    shareLinkCopied: 'Link Copied!',
    sshExportConnections: 'Export Connections',
    sshImportConnections: 'Import Connections',
    sshExportSuccess: 'Connections exported successfully',
    sshExportFailed: 'Export was not completed. Identity confirmation may have been cancelled or rejected.',
    sshImportSuccess: 'Connections imported successfully',
    sshImportFailed: 'Import failed',
    sshImportInvalidFormat: 'Invalid file format',
    sshImportCount: 'connections imported',
    sshExportCount: 'connections exported',
    sshExportMissingCredential: '{count} connection(s) have no portable password/private key and cannot be used offline on mobile',
    sshExportMobileUnsupported: '{count} connection(s) were exported but current mobile direct SSH import will reject their proxy, credential format, or size',
    sshNoConnectionsToExport: 'No connections to export',
    remoteSecureTransportRequired: 'Remote credentials require HTTPS/WSS. Plaintext LAN connections are blocked.',
    remoteScanComingSoon: 'LAN scan coming soon',
    remoteSessionAutoRefresh: 'Auto Refresh',
    remoteDeleteConnection: 'Delete',
    sshHostKeyUnknownTitle: 'Unknown Host Key',
    sshHostKeyUnknownMsg: 'The authenticity of host "{hostname}" cannot be established. Do you want to trust this host and continue connecting?',
    sshHostKeyType: 'Key Type',
    sshHostKeyFingerprint: 'Fingerprint',
    sshHostKeyTrust: 'Trust & Connect',
    sshHostKeyMismatchMsg: 'WARNING: Host key for {hostname} has CHANGED! This may indicate a man-in-the-middle attack. Key type: {keyType}, Fingerprint: {fingerprint}. Connection refused.',
    remotePairing: 'Requesting pairing...',
    remotePairApproved: 'Pairing approved!',
    remotePairDenied: 'Pairing denied',
    remotePairTimeout: 'Pairing request timed out',
    remoteScanBtn: 'Scan',
    remoteScanStop: 'Stop',
    customToken: 'Custom Token',
    kickSuccess: 'Kicked',
    deviceCardKickDevice: 'Kick Device',
    kickDeviceConfirm: 'Kick all connections from this device?',
    kickDeviceSuccess: 'Device kicked',
    kickedByHost: 'Kicked',
    kickedOverlayMsg: 'You have been disconnected by the host.',
    closeTab: 'Close Tab',
    confirmBanIp: 'Also ban this device\'s IP address?',
    banIpYes: 'Ban IP',
    enableTerminalNotifications: 'Allow Programs to Send Notifications',
    jsBypassProxy: 'Bypass system proxy (for internal JumpServer)',
    remoteTypeBadge: 'Remote',
    aiChatHistory: 'Chat History',
    aiChatHistoryEmpty: 'No chat history',
    aiChatHistoryTitle: 'Chat History',
    aiChatDeleteConfirmTitle: 'Delete Conversation',
    aiChatDeleteConfirmMsg: 'Delete this conversation and its host-binding backup and temporary file? This cannot be undone.',
    aiChatDeleteConfirmOk: 'Delete',
    aiChatDeleteConfirmCancel: 'Cancel',
    aiChatDeleteNoAskMinutes: "Don't ask again for 5 minutes",
    aiChatHistoryBack: 'Back',
    aiChatHostUnbound: 'Unbound',
    aiChatHostLocal: 'Local',
    aiChatHostMismatchTitle: 'Host mismatch',
    aiChatHostMismatch: 'Host mismatch. Switch to the conversation host or start a new conversation.',
    aiChatOpenElsewhereTitle: 'Already open',
    transferStatusPending: 'Waiting',
    transferStatusInProgress: 'Transferring',
    transferStatusCompleted: 'Completed',
    transferStatusFailed: 'Failed',
    transferStatusPaused: 'Paused',
    transferStatusCancelled: 'Cancelled',
    transferPause: 'Pause',
    transferResume: 'Resume',
    transferCancel: 'Cancel',
    transferDeleteRecord: 'Delete record',
    transferRevealIn: 'Show in file manager',
    transferEmpty: 'No transfers yet',
    transferNoMatch: 'No matching transfers',
    transferInterrupted: 'Interrupted: the app or window was closed',
    transferList: 'Transfers',
    transferFilterUpload: 'Uploads',
    transferFilterDownload: 'Downloads',
    transferFilterActive: 'In progress',
    transferClearHistory: 'Clear history',
    transferNotConnected: 'Not connected',
    aiChatHistoryLoadFailed: 'This conversation could not be read. It may have been deleted.',
    aiChatMessageCount: '{n} msgs',
    aiChatOpenElsewhere: 'This conversation is open in another tab. Continue it there, or close it there first.',
    aiChatPreviewAriaLabel: 'Read-only conversation history',
    aiChatPreviewNoticeBound: 'Read-only history. Switch to the matching host and reopen from history to continue. Ownership identifies the initial host, not every operation target.',
    aiChatPreviewNoticeUnbound: 'Legacy history is unbound. Confirm ownership, bind to the current host, then reopen from history to continue.',
    aiChatPreviewBack: 'Back',
    aiChatPreviewClose: 'Close',
    aiChatCopyConversation: 'Copy conversation',
    aiChatCopyFailed: 'Copy failed; retry',
    aiChatBindCurrentHost: 'Bind to current host',
    aiChatBindConfirmBody: 'Bind this legacy history to "{host}"? Confirm it belongs to this host. This saves ownership only; no commands run and the transcript remains unchanged.',
    aiChatBindConfirmTitle: 'Confirm host ownership',
    aiChatBindSuccessNotice: 'Bound. Return to history and reopen on the matching host to continue; no commands were executed.',
    aiChatBindSuccessStatus: 'Binding saved; original history backed up.',
    aiChatBindFailedStatus: 'Binding failed; ownership was not updated. Retry.',
    aiChatHistoryImageAlt: 'History image',
    aiChatHistorySearchPlaceholder: 'Search conversations or hosts',
    aiChatScopeCurrent: 'Current host',
    aiChatScopeAll: 'All conversations',
    aiAttachBtnTitle: 'Attach (click: paste clipboard image, or pick files if none · right click: paste clipboard image)',
    aiAttachRemoveImage: 'Remove image',
    aiAttachRemoveFile: 'Remove attachment',
    aiAttachImageChip: 'image{n}',
    aiAttachImageFilter: 'Images',
    aiAttachImageRejected: 'Image not attached',
    aiAttachImageReadFailed: '"{name}" could not be read — the limit is {limit} per image.',
    aiAttachImageUnsupported: 'Unsupported image format — PNG, JPEG, WebP or GIF only.',
    aiAttachImageTooMany: 'Up to {n} images per message.',
    aiAttachImageTooLarge: '{size} image — the limit is {limit} per image.',
    aiAttachImagesTooLarge: 'These images total {size} — the request limit is {limit}.',
    aiAttachImageStillTooLarge: 'Still too large at {px}px — resize it further, or attach fewer images.',
    aiAttachLimitTitle: 'Attachment limit',
    aiAttachLimitBody: 'Maximum {n} files can be queued at once. Remove an existing attachment first.',
    aiAttachEmptyTitle: 'Empty file',
    aiAttachEmptyBody: '"{name}" is empty (0 bytes) and cannot be attached.',
    aiAttachTooLargeTitle: 'File too large',
    aiAttachTooLargeBody: '"{name}" is {size}, exceeds the {limit} cap.\nUse the file manager or scp to transfer large files directly.',
    aiAttachCapError: 'file is {size}, exceeds the {limit} attachment cap',
    aiAttachDuplicateTitle: 'Duplicate file',
    aiAttachDuplicateBody: '"{name}" ({size}) is already queued.',
    aiAttachFailedTitle: 'Attachment failed',
    aiAttachSaveFailedBody: 'Could not save "{name}": {error}',
    aiAttachFailedBody: '"{name}": {error}',
    aiAttachDirTitle: 'Cannot attach directory',
    aiAttachDirBody: '"{name}" is a directory. Compress it first (zip/tar.gz) then attach the archive.',
    aiAttachNotFoundTitle: 'File not found',
    aiAttachNotFoundBody: '"{name}" does not exist or is inaccessible.',
    aiImageLightboxClose: 'Close (Esc)',
    aiBarHide: 'Hide',
    aiBarShow: 'Show AI Bar',
    aiModelNone: 'No model configured',
    aiPaneBadge: 'Pane {n}',
    aiPaneSentFrom: 'Sent from Pane {n}',
    aiPaneCrossCall: 'Cross-pane call',
    aiPaneDefaultTarget: 'Default target pane',
    aiTransferWaiting: 'waiting…',
    aiTransferCancel: 'Cancel transfer',
    aiTransferCompleted: 'completed',
    aiConfirmReject: 'Reject',
    aiConfirmEdit: 'Edit',
    aiConfirmAllOccurrences: ' (all occurrences)',
    aiConfirmMoreChars: '… (+{n} chars)',
    aiWaitDefaultReason: 'User input required',
    commonCopied: 'Copied!',
    updateAvailable: 'New version {version} is available',
    updateNow: 'Update Now',
    updateLater: 'Later',
    updateDownloading: 'Downloading {pct}%',
    updateFinishing: 'Installing...',
    updateRestarting: 'Restarting...',
    updateHint: 'The app will restart automatically after installation.',
    updateFailed: 'Update Failed',
    updateFailedHint: 'Please try again later or download the latest version manually.',
    updateModalTitle: 'Update to {version}',
    updateReleaseNotes: 'Release Notes',
    checkUpdates: 'Check for Updates',
    checkUpdatesUpToDate: "You're up to date",
    checkUpdatesChecking: 'Checking for updates…',
    updateModalClose: 'Close',
    hideUpdateIcon: 'Hide title bar update icon',
    openFileManager: 'Open File Manager',
    navigateConfirmMsg: 'Open file manager and navigate to {path}?',
    navigateCancel: 'Cancel',
    navigateConfirm: 'Open',
    fileLinkHint: '{mod}+Click to open {name}',
    fileLinkOpenLocal: 'Open with Default App',
    fileLinkOpenInDrawer: 'Open in File Manager',
    fileLinkDontAskAgain: "Don't ask again",
    fileLinkLocalConfirmMsg: 'Open <code>{path}</code> with system default application?',
    fileLinkConfirmOpen: 'Open',
    fileLinkSkipConfirmSetting: 'Confirm Before Opening File Links',
    autoNewSession: 'Open a Local Terminal on Startup',
    // JumpServer
    jsEditServer: 'Edit JumpServer',
    jsAddServer: 'Add JumpServer',
    jsName: 'Name',
    jsBaseUrl: 'Server URL',
    jsSshHost: 'SSH Host',
    jsSshHostPlaceholder: 'Koko SSH host (default: same as server)',
    jsAuthMethod: 'Auth Method',
    jsAuthPassword: 'Password',
    jsAuthToken: 'API Token',
    jsApiToken: 'API Token',
    jsOrgId: 'Organization ID',
    jsOrgIdPlaceholder: 'Optional, leave empty for default',
    jsTestConnection: 'Test',
    jsTesting: 'Testing…',
    jsTestSuccess: 'Connection successful',
    jsTestFailed: 'Connection failed',
    jsSave: 'Save',
    jsFieldsRequired: 'Name and Server URL are required',
    jsInvalidUrl: 'Invalid URL format',
    jsMfaTitle: 'Multi-Factor Authentication',
    jsMfaDesc: 'Enter the verification code',
    jsMfaCodePlaceholder: 'Verification code',
    jsMfaVerify: 'Verify',
    jsAssetBrowser: 'Asset Browser',
    jsSearchAssets: 'Search assets…',
    jsLoading: 'Loading…',
    jsAllAssets: 'All Assets',
    jsAssetsTotal: 'assets',
    jsNoAssets: 'No assets found',
    jsAssetName: 'Name',
    jsAssetAddress: 'Address',
    jsAssetPlatform: 'Platform',
    jsAssetComment: 'Comment',
    jsAssetProtocols: 'Protocols',
    jsAssetActions: 'Actions',
    jsConnect: 'Connect',
    jsConnectingAuth: 'Authenticating with JumpServer...',
    jsConnectingToken: 'Requesting connection token...',
    jsConnectingAsset: 'Connecting to {name}...',
    jsLoadingAccounts: 'Loading accounts…',
    jsNoAccounts: 'No accounts available',
    jsSelectAccount: 'Select Account',
    jsSessionExpired: 'JumpServer session expired',
    jsSessionExpiredDesc: 'Please sign in again to continue. Existing terminal sessions are not affected.',
    jsReconnectAction: 'Sign in again',
    jsLogoutAction: 'Sign out',
    jsLogoutConfirm: 'Sign out of {name}? Existing terminal sessions will be preserved.',
    jsLoginRequired: 'Please sign in to JumpServer first',
    jsReloginFailed: 'Sign-in failed. Check your credentials and try again.',
    jsItemActionsTitle: 'Actions',
    jsCredentialPromptTitle: 'Sign in to JumpServer',
    jsCredentialPromptDesc: 'Credentials required for {name}. None found in Keychain — please enter them again.',
    jsCredentialPromptUsername: 'Username',
    jsCredentialPromptPassword: 'Password',
    jsCredentialPromptApiToken: 'API Token',
    jsCredentialPromptSubmit: 'Sign in',
    jsCredentialStoredHint: 'Saved securely — leave blank to keep it',
    jsCredentialAuthorityChanged: 'Server, account, or proxy changed. Re-enter the primary credential before saving.',
    jsReturnToMainWindow: 'Return to main window',
    homeNewJumpServer: 'JumpServer',
    jsSaveAndConnect: 'Save & Connect',
    homeSearchPlaceholder: 'Search connections, commands or docs',
    homeGroupDefault: 'Default',
    homeGroupUngrouped: 'Recent',
    homeGroupManage: 'Manage Groups',
    homeGroupNew: 'New Group',
    homeGroupRename: 'Rename',
    homeGroupDelete: 'Delete Group',
    homeGroupDeleteConfirm: 'Delete this group? Connections will be moved to Recent.',
    homeGroupMoveToGroup: 'Move to Group',
    homeGroupNodeCount: '{count} Nodes',
    homeGroupResizeHint: 'Drag to resize — double-click to restore the default width',
    homeGroupColor: 'Color',
    homeGroupColorClear: 'Clear Color',
    homeGroupCollapse: 'Collapse',
    homeGroupExpand: 'Expand',
    homeGroupDuplicate: 'Duplicate Group',
    homeGroupNewName: 'Group Name',
    homeGroupNameReserved: 'Names starting with “__” are reserved by the app. Please pick another.',
    homeRecentActivity: 'Recent Activity',
    homeRecentRemove: 'Remove from history',
    homeFooterVersion: 'MeTerm v{version}',
    homeFooterGitHub: 'GitHub',
    homeNoConnections: 'No connections yet',
    homeSearchHint: 'Type to search connections, web, and command docs',
    homeSearchConnections: 'Connections',
    homeSearchWeb: 'Web Search',
    homeSearchTldr: 'Command Docs',
    homeSearching: 'Searching...',
    homeSearchLoadMore: 'Load more',
    homeSearchPerPage: '/page',
    homeNoResults: 'No results',
    settingsTabAbout: 'About',
    aboutVersion: 'Version',
    aboutDescription: 'A lightweight multi-session terminal client.',
    aboutGitHub: 'GitHub',
    aboutGitee: 'Gitee',
    aboutLicense: 'License',
    aboutCopyright: 'Copyright',
    aboutCheckUpdate: 'Check for Updates',
    aboutOpenSource: 'Open Source (in no particular order)',
    aboutLicenses: 'Licenses',
    aboutAckXterm: 'Terminal emulator',
    aboutAckTauri: 'Desktop framework',
    aboutAckConpty: 'Windows ConPTY',
    aboutAckJumpserver: 'Bastion host API',
    aboutAckTldr: 'Command documentation',
    aboutAckSearxng: 'Web search API',
    aboutAckCodemirror: 'Code editor',
    // tldr & command completion
    tldrHelp: 'Command Help',
    tldrEnable: 'Enable tldr command help',
    tldrNoData: 'No help data available. Click "Update Now" to download.',
    tldrUpdating: 'Updating help data…',
    tldrLastUpdated: 'Last updated: {date}',
    tldrUpdateNow: 'Update Now',
    tldrPageCount: '{count} commands indexed',
    tldrExamples: 'Examples',
    cmdCompletionEnable: 'Enable command completion (inline ghost text)',
    cmdCompletionHint: 'Shows grey suggestions in the terminal; press → to accept. Suggestions come from your command history first, then the tldr index.',
    shellHookEnable: 'Inject shell hook into SSH sessions',
    shellHookHint: 'Records full command history (including Tab completions) and lets the AI agent see exactly when a command finishes, its exit code and the current directory. When off, history comes from keyboard input only and the agent has to guess when commands finish.',
    settingsGroupCommandAssist: 'Command Assist',
    editorLargeFileWarning: 'This file is {size} MB. Opening large files may cause lag or crashes. Continue?',
    editorLargeFileTitle: 'Large File Warning',
    editorUnsavedChanges: 'You have unsaved changes. Discard and close?',
    editorSaving: 'Saving...',
    editorSaved: 'Saved',
    editorSaveFailed: 'Save failed',
    editorDisconnected: 'Session disconnected',
    editorReadOnly: 'Read-only',
    editorLoading: 'Loading...',
    editorMdPreview: 'Preview',
    editorMdPreviewOff: 'Hide Preview',
    editorWordWrap: 'Wrap',
    editorCut: 'Cut',
    editorCopy: 'Copy',
    editorPaste: 'Paste',
    editorSelectAll: 'Select All',
    editorSave: 'Save',
    editorCloseTab: 'Close Tab',
    editorFormat: 'Format',
  },
  zh: {
    settingsGroupGeneral: '通用',
    settingsGroupImportExport: '导入导出',
    settingsGroupFmDisplay: '显示',
    settingsGroupFmOpen: '打开文件',
    terminalThemeDark: '深色终端配色',
    terminalThemeDarkHint: '外观为深色时使用',
    terminalThemeLight: '浅色终端配色',
    terminalThemeLightHint: '外观为浅色时使用。外观选「自动」时两个都会用到',
    terminalThemeNb: '终端配色',
    terminalThemeNbHint: '由新粗野主义主题决定',
    uiFontHint: '标签、菜单、设置窗口等界面文字，不影响终端',
    opacityHint: '低于 100% 时能透出桌面',
    vibrancyHint: '让透出的桌面变模糊。窗口透明度为 100% 时看不出效果',
    backgroundImageHint: '显示在终端后面',
    backgroundImageStrength: '图片强度',
    aiBarOpacityHint: '只影响终端底部的 AI 输入栏',
    fontSizeHint: '也可以在终端里用 ⌘/Ctrl 加减号调整',
    cjkFontHint: '中日韩字符使用的字体',
    fontFeatureHint: '当前字体不支持时无法开启',
    fontSharpnessHint: '可能影响滚动流畅度',
    defaultShellHint: '只影响本机终端，SSH 连接使用服务器上的 Shell',
    encodingHint: '对所有已打开的会话立即生效。只在连接老服务器出现乱码时修改',
    terminalNotificationsHint: '终端里的程序通过转义序列发出的提醒，同一会话 3 秒内最多一条',
    fileLinkConfirmHint: '点击终端里的文件路径时先弹窗确认',
    fileManagerPositionHint: '底部抽屉或左侧边栏（树形）。也可以在文件管理器里直接切换',
    fileOpenPreferenceSetting: '双击文本和图片文件时',
    fileOpenPreferenceHint: '远程文件用系统应用打开时会先下载',
    autoNewSessionHint: '关闭时启动后停在首页',
    rememberWindowSizeHint: '包括是否最大化',
    sshTabTitleHint: '用连接名，或用服务器上程序设置的标题',
    enableThumbnailHint: '工具栏显示「会话总览」按钮，用缩略图查看所有会话',
    previewRefreshRateHint: '越短越实时，也越耗电',
    pipScaleHint: '画中画窗口相对原窗口的大小',
    pipScaleByScreenHint: '关闭时按主窗口大小计算',
    contextMenuIntegrationMac: '在访达右键菜单中添加「在 MeTerm 中打开」',
    contextMenuIntegrationWin: '在资源管理器右键菜单中添加「在 MeTerm 中打开」',
    autoOpenAiOnConnectHint: '连接 SSH 主机成功后',
    sshSavedConnectionsHint: '导出文件包含密码和私钥明文，导出前会要求验证身份。导入会覆盖同名连接',
    appName: 'MeTerm',
    settings: '设置',
    settingsTabAppearance: '外观',
    settingsTabTerminal: '终端',
    settingsTabGeneral: '通用',
    settingsPageAppearance: '外观',
    settingsPageTerminal: '终端',
    settingsPageFileManager: '文件管理器',
    settingsPageTabsWindows: '标签与窗口',
    settingsPageConnections: '连接',
    settingsGroupTheme: '主题',
    settingsGroupBackground: '窗口背景',
    settingsGroupFont: '字体',
    settingsGroupShell: 'Shell 与编码',
    settingsGroupTerminalBehavior: '行为',
    settingsGroupTabs: '标签页',
    settingsGroupWindow: '启动与窗口',
    settingsGroupPip: '画中画',
    settingsGroupSystem: '系统集成',
    settingsGroupOnConnect: '连接后',
    settingsSearchPlaceholder: '搜索设置',
    settingsSearchNoResults: '没有匹配的设置',
    opacity: '窗口透明度',
    enableVibrancy: '背景模糊',
    fontSize: '字体大小',
    fontFamily: '字体',
    uiFontFamily: '界面字体',
    cjkFontFamily: '中文字体',
    cjkFontAuto: '系统默认',
    enableNerdFont: 'Nerd Font 图标',
    enableLigatures: '编程连字',
    fontWeight: '字重',
    fontSharpness: '文字锐化',
    encoding: '字符编码',
    fileManagerFontSize: '字体大小',
    enableThumbnail: '会话总览',
    previewRefreshRate: '缩略图刷新间隔',
    previewRate100: '100毫秒 (最快)',
    previewRate500: '500毫秒 (快)',
    previewRate1000: '1秒 (正常)',
    previewRate2000: '2秒 (慢)',
    previewRate5000: '5秒 (最慢)',
    fileManagerPosition: '位置',
    fileManagerPositionDrawer: '底部抽屉',
    fileManagerPositionSidebar: '左侧边栏 (树形视图)',
    newTerminal: '新建终端',
    noSessions: '没有终端会话',
    newSessionHint: '按 ⌘T 或点击 "新建终端" 创建一个',
    connecting: '连接中',
    connected: '已连接',
    reconnecting: '重连中',
    ended: '已结束',
    sessionNotFound: '会话未找到',
    disconnected: '已断开',
    statusLocal: '本地',
    statusError: '错误',
    statusPaneLabel: '窗格 · {total}',
    statusPaneTitle: '第 {n} 个窗格，共 {total} 个',
    statusTransferFiles: '{count} 个文件',
    statusTransferFile: '{count} 个文件',
    statusTransferDone: '完成',
    statusTooltipStatus: '状态：{value}',
    statusTooltipLatency: '延迟：{ms}ms',
    statusTooltipSessions: '标签：{count}',
    statusStartFailed: '启动 meterm 失败',
    reconnect: '重新连接',
    active: '当前',
    language: '语言',
    closeSession: '关闭会话',
    contextMenuNewTerminal: '新建终端',
    contextMenuHome: '主页',
    contextMenuSettings: '设置',
    contextMenuCloseSession: '关闭当前会话',
    contextMenuCopy: '复制',
    contextMenuPaste: '粘贴',
    responseSession: '响应会话',
    hideToTrayTipTitle: '隐藏到系统托盘？',
    hideToTrayTipBody: '将窗口隐藏到系统托盘？点击托盘图标可重新打开。',
    hideToTrayTipDontShow: '不再提示',
    hideToTrayTipOk: '知道了',
    hideToTrayTipHideNow: '隐藏到状态栏',
    hideToTrayTipCancel: '取消',
    hideToTrayTipRemember: '记住选项？',
    confirmQuitWithSessions: '当前有未关闭会话，确认退出并关闭全部会话吗？',
    confirmCloseAllSessions: '确认关闭所有会话吗？',
    confirmCloseWindowWithSessions: '此窗口有活跃的会话。关闭窗口将结束所有会话，是否继续？',
    confirmQuitAllWindows: '关闭所有窗口及会话？这将退出应用程序。',
    confirmHideToTrayWithSessions: '检测到有活跃会话，是否将窗口隐藏到状态栏？',
    aboutDialogTitle: '关于',
    aboutDialogBody: '轻量的多会话终端客户端。',
    shortcutsDialogTitle: '快捷键',
    shortcutsDialogBody: '',
    shortcutNewTerminal: '新建终端',
    shortcutCloseSession: '关闭当前会话',
    shortcutClearTerminal: '清屏',
    shortcutClearInput: '清空当前输入',
    shortcutOpenSettings: '打开设置',
    shortcutSplitHorizontal: '水平分屏',
    shortcutSplitVertical: '垂直分屏',
    shortcutNavigatePanes: '在面板间导航',
    shortcutSwitchToTab: '切换到第 1–8 / 最后一个标签',
    shortcutNextTab: '下一个标签',
    shortcutPrevTab: '上一个标签',
    colorScheme: '外观模式',
    colorSchemeAuto: '自动（跟随系统）',
    colorSchemeDark: '深色',
    colorSchemeDarker: '纯黑',
    colorSchemeNavy: '深海蓝',
    colorSchemeLight: '浅色',
    colorSchemeNeoBrutalism: '新粗野主义',
    colorSchemeNeoBrutalismRounded: '新粗野主义 (圆角)',
    nbPaletteTitle: '新粗野主义配色',
    nbBg: '主背景',
    nbText: '主文字',
    nbBorder: '边框',
    nbShadow: '阴影',
    nbAccent: '强调色',
    nbHighlight: '高亮色',
    nbSuccess: '成功',
    nbInfo: '信息',
    nbDanger: '危险',
    nbSurfaceAlt: '辅助背景',
    nbReset: '重置配色',
    nbPresetSunset: '🌅 日落',
    nbPresetOcean: '🌊 海洋',
    nbPresetSakura: '🌸 樱花',
    nbPresetForest: '🌲 森林',
    nbPresetLavender: '💜 薰衣草',
    nbPresetMidnight: '🌙 午夜',
    nbPresetCyber: '👾 赛博朋克',
    nbPresetAbyss: '🌀 深渊',
    nbPresetCandy: '🍬 糖果',
    nbPresetRetro: '📺 复古',
    nbPresetNord: '❄️ 极光',
    nbPresetDracula: '🧛 德古拉',
    nbPresetSolarized: '☀️ 曝光',
    nbPresetOnyx: '🖤 玛瑙黑',
    nbPresetEmber: '🔥 余烬',
    nbPresetMatrix: '💚 矩阵',
    nbPresetStealth: '🥷 隐匿',
    nbPresetMocha: '☕ 摩卡',
    rememberWindowSize: '记住窗口位置和大小',
    connectionSort: '组内排序',
    connectionSortDefault: '默认顺序',
    connectionSortIpAsc: 'IP 升序',
    connectionSortIpDesc: 'IP 降序',
    connectionSortNameAsc: '名称升序',
    connectionSortNameDesc: '名称降序',
    sshTabTitleMode: 'SSH 标签名称',
    autoOpenAiOnConnect: '自动打开 AI 面板',
    autoRestoreAiHistoryOnConnect: '恢复这台主机最近的对话',
    sshTabTitleConnection: '连接名称',
    sshTabTitleTerminal: '终端动态标题',

    rememberDrawerLayout: '记住抽屉高度',
    pipScale: '缩放比例',
    pipScaleByScreen: '按屏幕大小计算',
    sessionsGallery: '会话总览',
    sshConnect: 'SSH 连接',
    sshHost: '主机地址',
    sshPort: '端口',
    sshUsername: '用户名',
    sshAuthMethod: '认证方式',
    sshPassword: '密码',
    sshPrivateKey: '私钥路径',
    sshConnectBtn: '连接',
    sshDisconnect: '断开连接',
    sshConnecting: '连接中...',
    sshConnected: '已连接',
    sshFailed: '连接失败',
    sshAuthPassword: '密码认证',
    sshAuthKey: '公钥认证',
    sshSavedConnections: '已保存的连接',
    sshNoSavedConnections: '暂无保存的连接',
    sshQuickConnect: '快速连接',
    sshNewConnection: '新建连接',
    sshDeleteConnection: '删除',
    sshConnectionName: '连接名称',
    sshSaveConnection: '保存',
    sshTestConnection: '测试连接',
    sshProxy: '代理',
    advancedOptions: '高级选项',
    sshProxyType: '代理类型',
    sshProxyNone: '直连',
    sshProxyHost: '代理地址',
    sshProxyPort: '端口',
    sshProxyUsername: '用户名',
    sshProxyPassword: '密码',
    sshTestSuccess: '连接成功！',
    sshTestFailed: '连接失败',
    sshTesting: '测试中...',
    sshConnectAndSave: '连接并保存',
    sshUnsavedConfirm: '有未保存的更改，确定关闭？',
    sshUnsavedDiscard: '放弃',
    sshUnsavedCancel: '取消',
    sshAuthFailedTitle: '认证失败',
    sshAuthFailedMsg: '保存的密码可能已变更，请输入 {username}@{host} 的新密码：',
    sshAuthFailedRetry: '重新连接',
    sshPasswordUpdated: '密码已更新并保存。',
    sshKeyBrowse: '浏览私钥文件',
    sshKeyBrowseTitle: '选择私钥',
    sshKeyPlaceholderDefault: '~/.ssh/id_rsa  (留空可自动检测)',
    sshKeyPlaceholderAuto: '留空将自动使用 {path}',
    sshKeyPlaceholderAgent: '留空将通过 ssh-agent 认证',
    sshAgentBadge: 'agent: {count}',
    sshAgentBadgeHint: 'ssh-agent 已就绪，里面有这些已加载的身份。留空密钥路径即可使用。',
    sshUseDesktopKeyLadder: '使用本机 ssh-agent 或 ~/.ssh 默认密钥（保存时需身份确认）',
    sshKeySourceRequired: '请选择私钥，或明确启用本机 ssh-agent/默认密钥选项。',
    sshAuthUsedAgentTitle: '已通过 ssh-agent 连接',
    sshAuthUsedAgentBody: '使用 ssh-agent 中的密钥完成了认证。',
    sshAuthUsedDefaultTitle: '已通过默认密钥连接',
    sshAuthUsedDefaultBody: '使用 ~/.ssh/ 下的默认密钥完成了认证。',
    drawerTabFiles: '文件',
    sidebarRefresh: '刷新',
    sidebarNewFolder: '新建文件夹',
    sidebarUpload: '上传',
    sidebarToggleHidden: '显示/隐藏文件',
    sidebarLockRoot: '解锁以跟随终端目录',
    sidebarUnlockRoot: '锁定当前目录',
    sidebarSwitchView: '切换视图',
    sidebarNewFolderPrompt: '请输入文件夹名称：',
    sidebarItems: '项',
    sidebarInfoDirs: '个文件夹',
    sidebarInfoFiles: '个文件',
    sidebarMoveTitle: '移动 {count} 个项目？',
    sidebarMoveConfirm: '移动',
    sidebarMoveCancel: '取消',
    sidebarMoveDest: '目标位置',
    sidebarEmptyDir: '空目录',
    sidebarTreeMore: '还有 {n} 项,点击加载',
    fileManager: '文件管理',
    ctxMenuOpen: '打开',
    ctxMenuSetAsRoot: '设为根目录',
    ctxMenuOpenWith: '打开方式',
    ctxMenuBuiltinEditor: '内置编辑器',
    ctxMenuSystemDefault: '系统默认',
    ctxMenuDownloadN: '下载 {count} 个文件',
    ctxMenuDownloadFolder: '下载文件夹',
    ctxMenuDownload: '下载',
    ctxMenuUpload: '上传',
    ctxMenuUploadToFolder: '上传到此文件夹',
    ctxMenuUploadToCurrent: '上传到当前路径',
    ctxMenuNewFile: '新建文件',
    ctxMenuNewFolder: '新建文件夹',
    ctxMenuCopyPath: '复制路径',
    ctxMenuCopyAbsPath: '复制绝对路径',
    ctxMenuTerminalOps: '终端操作',
    ctxMenuCopyTo: '复制到...',
    ctxMenuCopyToN: '复制 {count} 个文件到...',
    ctxMenuMoveTo: '移动到...',
    ctxMenuMoveToN: '移动 {count} 个文件到...',
    ctxMenuSymlink: '创建符号链接',
    ctxMenuChmod: '修改权限',
    ctxMenuRename: '重命名',
    ctxMenuDelete: '删除',
    ctxMenuDeleteN: '删除 {count} 个文件',
    ctxMenuProperties: '详情',
    ctxMenuMore: '更多',
    ctxMenuView: '视图',
    ctxMenuBookmark: '收藏当前目录',
    ctxMenuRefresh: '刷新',
    ctxMenuShowHidden: '显示隐藏文件',
    serverInfoToggle: '服务器信息',
    serverInfoHost: '主机',
    serverInfoUser: '用户',
    serverInfoOS: '系统',
    serverInfoKernel: '内核',
    serverInfoUptime: '运行',
    serverInfoLoad: '负载',
    serverInfoCPU: 'CPU',
    serverInfoMemory: '内存',
    serverInfoSwap: '交换',
    serverInfoProcesses: '进程',
    serverInfoDisk: '磁盘',
    serverInfoNetwork: '网络',
    serverInfoLoading: '加载中...',
    serverInfoPanelClose: '关闭',
    serverInfoCores: '核',
    serverInfoResources: '资源',
    serverInfoSwapOff: '未启用',
    connectionsWindowTitle: '连接',
    connectionsWindowHint: '点击连接即打开会话。⌘/Ctrl 点击可多选，再拖到分组上即可移动。',
    connectionsWindowSettings: '设置',
    connectionsWindowOpenFailed: '无法打开连接窗口。',
    connectionMoveToGroup: '移动到分组',
    connectionClearSelection: '取消选择',
    connectionGroupEmptyHint: '拖放连接到此处',
    connectionDeleteFailedTitle: '删除连接失败',
    connectionDeleteFailedBody: '该连接仍保留在列表中，详情见控制台。',
    toolbarAiAgent: 'AI 助手',
    toolbarHome: '主页',
    toolbarAlwaysOnTop: '窗口置顶',
    toolbarUnpinFromTop: '取消置顶',
    toolbarPictureInPicture: '画中画',
    toolbarExitPictureInPicture: '退出画中画',
    windowMinimize: '最小化',
    windowMaximize: '最大化',
    windowRestore: '还原',
    windowClose: '关闭',
    appMenuTitle: '应用菜单',
    appMenuNewWindow: '新窗口',
    appMenuImportConnections: '导入连接',
    appMenuExportConnections: '导出连接',
    appMenuCloseAllSessions: '关闭所有会话',
    appMenuCloseWindow: '关闭窗口',
    appMenuQuit: '退出应用',
    processColCommand: '命令',
    processColCPU: 'CPU%',
    processColMem: '内存%',
    backgroundImage: '背景图片',
    backgroundImageSelect: '选择图片',
    backgroundImageClear: '清除',
    homeNewLocalSession: '新建本地会话',
    homeNewSSHSession: '新建 SSH 会话',
    noShellsFound: '未找到可用的 Shell',
    defaultShell: '默认',
    defaultShellSetting: '默认 Shell',
    contextMenuIntegration: '添加"在 MeTerm 中打开"到右键菜单',
    systemDefault: '跟随系统',
    homeSavedConnections: '已保存的连接',
    homeEditConnection: '编辑',
    homeShowMore: '展开更多',
    homeShowLess: '收起',
    homeRecentConnections: '最近连接',
    aiCapsule: 'MeAgent',
    aiBarOpacity: 'AI 输入栏透明度',
    aiSendCommand: '发送命令',
    aiSendPrompt: '发送提示词',
    aiModelSelect: '模型',
    aiPlaceholderInput: '输入命令或提示词...',
    aiPlaceholderCmd: '命令 ',
    aiPlaceholderAgent: ' 询问 MeAgent... ',
    aiCollapse: '收起',
    aiExpand: '展开',
    aiLayoutSide: '侧边栏',
    aiLayoutBottom: '底部',
    aiHistory: '历史',
    aiHistoryEmpty: '暂无命令历史',
    aiSearchHistory: '搜索命令历史...',
    aiSearchChatHistory: '搜索对话历史...',
    aiSourceManual: '手动',
    aiTimeJustNow: '刚刚',
    aiCopyCommand: '复制命令',
    settingsTabAI: 'AI',
    aiProvider: '服务商',
    aiGroupProviders: '模型服务',
    aiGroupReply: '回复',
    aiGroupAgent: 'Agent',
    aiGroupWebSearch: '联网搜索',
    aiGroupChatHistory: '对话历史',
    aiGroupHostNotes: '主机备忘',
    aiHostNotesNone: '还没有备忘。AI 在服务器上做事时学到有用的信息（比如应用目录、重启方法），会在你确认后记在这里，下次在同一台服务器上工作时自动参考。',
    aiHostNotesHint: 'AI 在某台主机上工作时会看到它的备忘。每行一条。离开输入框时自动保存，清空文字即删除。',
    aiHostNotesLocal: '本机',
    aiHostNotesDelete: '删除',
    aiHostNotesDeleteConfirm: '再点一次删除',
    aiHostNotesUpdated: '更新于 {time}',
    aiHostNotesBtnTitle: '主机备忘',
    aiHostNotesPlaceholder: '还没有备忘。每行一条，例如：\n应用在 /srv/app，用 systemctl restart app 重启',
    aiHostNotesNoHost: '当前窗格还没有连接主机，无法记录备忘。',
    aiHostNotesManage: '全部主机…',
    aiHostNotesLoaded: '已载入 {host} 的主机备忘（{count} 条）',
    aiSaveChatHistory: '保存 AI 对话历史',
    aiSaveChatHistoryHint: '把 AI 对话保存在本机，之后可以重新打开。Agent 在终端提示符里输入的内容和工具截的图不会保存，过长的命令输出会截短。',
    aiChatHistoryLimit: '保留',
    aiChatHistoryLimitHint: '超出数量时从最旧的对话开始删除，标签中打开着的对话不会被删。',
    aiChatHistoryLimitAll: '全部保留',
    aiGroupAdvanced: '高级',
    aiAdvancedSummary: '温度、对话历史上限、附带终端行数',
    aiPreset: '快速选择',
    aiApiKey: 'API 密钥',
    aiBaseUrl: 'API 地址',
    aiModelName: '模型',
    aiTemperature: '温度',
    aiTemperatureHint: '越高回答越发散。Claude Opus 4.7 及以后的模型和 OpenAI 推理模型会忽略这一项。',
    aiMaxTokens: '单次回复上限',
    aiMaxTokensHint: '模型一次最多输出多少 token，思考内容也算在内。',
    aiContextLines: '附带终端行数',
    aiContextLinesHint: '有 Shell Hook 时，每次提问会附上你最近一条命令及其完整输出；没有时，附上终端最近这么多行。',
    aiHistoryBudget: '对话历史上限',
    aiHistoryBudgetHint: '对话超过这个长度后，较早的消息会被自动压缩成摘要。',
    aiEnableThinking: '思考模式',
    aiEnableThinkingHint: '仅对 DeepSeek、Qwen（阿里百炼）、GLM、MiMo 等 OpenAI 兼容接口生效，Claude、OpenAI、Gemini 会忽略。',
    aiThinkingBudget: '思考预算',
    aiThinkingBudgetHint: '限制回答前用于思考的 token，避免思考把单次回复上限用光。开启思考模式后生效。',
    aiThinkingBudgetDefault: '跟随模型',
    aiThinkingBudgetLow: '低（4k）',
    aiThinkingBudgetMedium: '中（16k）',
    aiThinkingBudgetHigh: '高（32k）',
    aiThinkingOn: '思考已开启',
    aiThinkingOff: '思考已关闭',
    aiPermissionMode: '权限模式',
    aiPermissionModeAsk: '每次询问',
    aiPermissionModeAcceptSafe: '安全操作自动执行',
    aiPermissionModeAcceptAll: '除危险操作外自动执行',
    aiPermissionModePlan: '只读计划',
    aiPermissionModeBypass: '全部放行（不再询问）',
    aiPermissionModeHint: 'Agent 使用工具前要不要先问你，AI 输入栏上的盾牌按钮切换的也是这一项。只读计划不会做任何修改；读取敏感文件或工作目录外的文件时总会询问。',
    aiPermissionModeChanged: '权限模式：{mode}',
    aiPermissionRules: '权限规则',
    aiPermissionRulesAdd: '添加规则',
    aiPermissionRulesNone: '无自定义规则。读取敏感路径或工作目录外的文件需要确认；Accept safe 模式仅对识别为危险的命令要求确认。',
    aiPermissionActionAllow: '允许',
    aiPermissionActionDeny: '拒绝',
    aiPermissionActionAsk: '询问',
    aiPermissionRuleTool: '工具',
    aiPermissionRuleCmdMatch: '命令正则',
    aiPermissionRulePathMatch: '路径正则',
    aiPermissionRuleRegexInvalid: '正则表达式无效，请修正后再保存规则。',
    aiPermissionRuleSave: '保存',
    aiPermissionRuleCancel: '取消',
    aiPermissionRuleToolRequired: '请输入工具名（* 匹配所有工具）。',
    aiAuditLog: '操作记录',
    aiAuditLogOpen: '打开',
    aiAuditLogEmpty: '(暂无审计记录)',
    aiAuditLogClose: '关闭',
    aiAuditLogClear: '清空日志',
    aiAuditLogReload: '刷新',
    aiAuditLogClearConfirm: '确定清空所有审计记录?此操作不可撤销。',
    aiNotifyWaitingTitle: 'AI Agent 需要确认',
    aiNotifyCompleteTitle: 'AI Agent 已完成',
    aiNotifyCompleteBody: 'Agent 已完成当前任务。',
    aiNotifyErrorTitle: 'AI Agent 遇到错误',
    aiNotifyErrorBody: 'Agent 执行中止,请查看详情。',
    aiAgentMaxIterations: '最多连续执行步数',
    aiAgentUnlimited: '无限制',
    aiTestConnection: '测试连接',
    aiTestSuccess: '连接成功！',
    aiTestFailed: '连接失败',
    aiTesting: '测试中...',
    aiNewChat: '新对话',
    aiClearChat: '清空对话',
    aiRunCommand: '执行',
    aiCopyCode: '复制',
    aiCopyResponse: '复制回答',
    aiCopyFailed: '复制失败，请重试',
    aiDangerConfirmTitle: '危险命令',
    aiDangerConfirmMsg: '该命令可能造成不可逆的更改，确定要执行吗？',
    aiDangerConfirmRun: '仍然执行',
    aiDangerConfirmCancel: '取消',
    aiNoConfig: 'AI 未配置，请前往 设置 > AI 进行配置。',
    aiStreamError: '请求失败',
    aiRateLimitRetry: '请求频率受限，正在重试',
    aiServerErrorRetry: '服务暂时不可用，正在重试',
    aiNetworkRetry: '网络异常，正在重试',
    aiContextCompressed: '上下文已压缩以适应模型限制',
    aiContextCompressedOverflow: '上下文超出模型上限，已压缩后重试',
    aiThinking: '思考中',
    aiWorking: '工作中',
    aiStopGenerating: '停止',
    aiSendToAgentConfirm: '这看起来是提示词，发送给 MeAgent？',
    aiSendToAgentDontAsk: '不再询问，默认发送至 MeAgent',
    aiSendToAgentYes: '发送给 Agent',
    aiSendToAgentNo: '发送到终端',
    aiPlaceholderAgentMode: ' MeAgent ',
    aiCtxCopy: '复制',
    aiCtxCopyResult: '复制结果',
    aiCtxResend: '重新发送',
    aiCtxDelete: '删除',
    aiModelAuto: '自动',
    aiModelAutoDesc: '使用当前服务商的默认模型',
    aiAddProvider: '添加提供商',
    aiDeleteProvider: '删除',
    aiProviderProtocol: '协议',
    aiFetchModels: '拉取模型',
    aiFetching: '拉取中...',
    aiFetchSuccess: '个模型已加载',
    aiFetchFailed: '拉取失败',
    aiNoModels: '暂无模型，点击"拉取模型"加载。',
    aiModelsCount: '个模型',
    aiSelectModels: '选择模型',
    aiProviderLabel: '名称',
    aiCustomProvider: '自定义',
    aiProviderKeySaved: '已保存 Key',
    aiProviderNoKey: '未设置 Key',
    aiProviderModelsEnabled: '已启用 {count} 个模型',
    aiProviderNoModelsEnabled: '未启用模型',
    aiProviderEdit: '编辑',
    aiProviderDone: '完成',
    aiSearxng: '网络搜索 (SearXNG)',
    aiSearxngUrl: 'SearXNG 地址',
    aiSearxngUrlPlaceholder: 'https://searx.example.org',
    aiSearxngAuth: '认证',
    aiSearxngUsername: '用户名（可选）',
    aiSearxngPassword: '密码（可选）',
    aiSearxngEnable: '允许 Agent 联网搜索',
    aiSearxngEnableHint: '使用你自己的 SearXNG 实例。',
    aiSearxngTest: '测试',
    aiSearxngTestOk: 'SearXNG 连接成功！',
    aiSearxngTestFail: 'SearXNG 连接失败',
    tabMenuCloseTab: '关闭此标签',
    tabMenuCloseOthers: '关闭其他标签',
    tabMenuCloseLeft: '关闭左侧标签',
    tabMenuCloseRight: '关闭右侧标签',
    tabMenuCloseAll: '关闭所有标签',
    tabMenuCopyTitle: '复制标签标题',
    tabMenuCloneTab: '克隆标签',
    splitHorizontal: '水平分屏',
    splitVertical: '垂直分屏',
    closePane: '关闭面板',
    pairingToken: '令牌',
    homeMobilePairing: '手机配对',
    masterRequestTitle: '控制权申请',
    masterRequestMessage: '一个远程观察者请求控制终端。',
    masterRequestApprove: '同意',
    masterRequestDeny: '拒绝',
    reclaimControl: '夺回控制权',
    reclaimClickHint: '点击取消远控',
    reclaimSpaceHint: '(空格取消远控)',
    shareLink: '复制分享链接',
    shareLinkCopied: '链接已复制!',
    sshExportConnections: '导出连接',
    sshImportConnections: '导入连接',
    sshExportSuccess: '连接导出成功',
    sshExportFailed: '导出未完成，身份确认可能已取消或被系统拒绝。',
    sshImportSuccess: '连接导入成功',
    sshImportFailed: '导入失败',
    sshImportInvalidFormat: '文件格式无效',
    sshImportCount: '个连接已导入',
    sshExportCount: '个连接已导出',
    sshExportMissingCredential: '其中 {count} 个连接没有可迁移的密码或私钥，无法在手机离线直连',
    sshExportMobileUnsupported: '其中 {count} 个连接已导出，但其代理、凭据格式或大小不受当前手机直连导入支持',
    sshNoConnectionsToExport: '没有可导出的连接',
    remoteSecureTransportRequired: '远程凭据必须通过 HTTPS/WSS 传输，已拦截局域网明文连接。',
    remoteScanComingSoon: '局域网扫描即将推出',
    remoteSessionAutoRefresh: '自动刷新',
    remoteDeleteConnection: '删除',
    sshHostKeyUnknownTitle: '未知主机密钥',
    sshHostKeyUnknownMsg: '无法验证主机 "{hostname}" 的真实性。是否信任此主机并继续连接？',
    sshHostKeyType: '密钥类型',
    sshHostKeyFingerprint: '指纹',
    sshHostKeyTrust: '信任并连接',
    sshHostKeyMismatchMsg: '警告：主机 {hostname} 的密钥已变更！这可能表示中间人攻击。密钥类型：{keyType}，指纹：{fingerprint}。连接已拒绝。',
    remotePairing: '正在请求配对...',
    remotePairApproved: '配对已通过!',
    remotePairDenied: '配对被拒绝',
    remotePairTimeout: '配对请求超时',
    remoteScanBtn: '扫描',
    remoteScanStop: '停止',
    customToken: '自定义 Token',
    kickSuccess: '已踢出',
    deviceCardKickDevice: '踢出设备',
    kickDeviceConfirm: '确定踢出该设备的所有连接？',
    kickDeviceSuccess: '设备已踢出',
    kickedByHost: '已被踢出',
    kickedOverlayMsg: '你已被主机断开连接。',
    closeTab: '关闭标签',
    confirmBanIp: '是否同时封禁该设备的 IP 地址？',
    banIpYes: '封禁 IP',
    enableTerminalNotifications: '允许程序发送系统通知',
    jsBypassProxy: '绕过系统代理（内网 JumpServer）',
    remoteTypeBadge: '远程',
    aiChatHistory: '对话历史',
    aiChatHistoryEmpty: '暂无对话历史',
    aiChatHistoryTitle: '对话历史',
    aiChatDeleteConfirmTitle: '删除对话',
    aiChatDeleteConfirmMsg: '确定删除这条对话及其主机绑定备份和临时文件吗？此操作无法撤销。',
    aiChatDeleteConfirmOk: '删除',
    aiChatDeleteConfirmCancel: '取消',
    aiChatDeleteNoAskMinutes: '5 分钟内不再提示',
    aiChatHistoryBack: '返回',
    aiChatHostUnbound: '未绑定',
    aiChatHostLocal: '本机',
    aiChatHostMismatchTitle: '主机不匹配',
    aiChatHostMismatch: '当前主机与对话归属不匹配，请切换到对应主机或新建对话。',
    aiChatOpenElsewhereTitle: '对话已打开',
    transferStatusPending: '等待中',
    transferStatusInProgress: '传输中',
    transferStatusCompleted: '已完成',
    transferStatusFailed: '失败',
    transferStatusPaused: '已暂停',
    transferStatusCancelled: '已取消',
    transferPause: '暂停',
    transferResume: '继续',
    transferCancel: '取消',
    transferDeleteRecord: '删除记录',
    transferRevealIn: '在文件管理器中打开',
    transferEmpty: '暂无传输记录',
    transferNoMatch: '无匹配记录',
    transferInterrupted: '传输中断：应用或窗口已关闭',
    transferList: '传输列表',
    transferFilterUpload: '上传',
    transferFilterDownload: '下载',
    transferFilterActive: '进行中',
    transferClearHistory: '清空历史',
    transferNotConnected: '未连接',
    aiChatHistoryLoadFailed: '无法读取这条对话，它可能已被删除。',
    aiChatMessageCount: '{n} 条',
    aiChatOpenElsewhere: '这条对话已在另一个标签中打开，请在那边继续，或先在那边关闭。',
    aiChatPreviewAriaLabel: '只读对话历史',
    aiChatPreviewNoticeBound: '只读历史。切换到对应主机后，从历史列表重新打开即可继续。归属表示首次发送的主机，不代表所有操作的目标。',
    aiChatPreviewNoticeUnbound: '旧历史尚未绑定主机。确认归属后，可绑定当前主机，再从历史列表打开继续。',
    aiChatPreviewBack: '返回',
    aiChatPreviewClose: '关闭',
    aiChatCopyConversation: '复制对话',
    aiChatCopyFailed: '复制失败，请重试',
    aiChatBindCurrentHost: '绑定到当前主机',
    aiChatBindConfirmBody: '将这段旧历史绑定到「{host}」？请确认它属于此主机。仅保存归属，不执行命令；对话内容保持不变。',
    aiChatBindConfirmTitle: '确认主机归属',
    aiChatBindSuccessNotice: '已绑定。返回历史列表后重新打开，即可在匹配主机继续；本次没有执行命令。',
    aiChatBindSuccessStatus: '绑定成功，原历史已备份。',
    aiChatBindFailedStatus: '绑定失败，归属未更新，请重试。',
    aiChatHistoryImageAlt: '历史图片',
    aiChatHistorySearchPlaceholder: '搜索对话或主机',
    aiChatScopeCurrent: '当前主机',
    aiChatScopeAll: '全部对话',
    aiAttachBtnTitle: '添加附件（左键：粘贴剪贴板图片，没有图片时选择文件 · 右键：粘贴剪贴板图片）',
    aiAttachRemoveImage: '移除图片',
    aiAttachRemoveFile: '移除附件',
    aiAttachImageChip: '图片{n}',
    aiAttachImageFilter: '图片',
    aiAttachImageRejected: '图片未添加',
    aiAttachImageReadFailed: '无法读取“{name}”，单张图片上限为 {limit}。',
    aiAttachImageUnsupported: '不支持的图片格式，仅支持 PNG、JPEG、WebP 或 GIF。',
    aiAttachImageTooMany: '每条消息最多 {n} 张图片。',
    aiAttachImageTooLarge: '图片大小 {size}，单张上限为 {limit}。',
    aiAttachImagesTooLarge: '图片合计 {size}，单次请求上限为 {limit}。',
    aiAttachImageStillTooLarge: '缩小到 {px}px 后仍然过大，请先自行缩小图片或减少图片数量。',
    aiAttachLimitTitle: '附件数量已达上限',
    aiAttachLimitBody: '最多同时添加 {n} 个文件，请先移除已有附件。',
    aiAttachEmptyTitle: '空文件',
    aiAttachEmptyBody: '“{name}”是空文件（0 字节），无法添加。',
    aiAttachTooLargeTitle: '文件过大',
    aiAttachTooLargeBody: '“{name}”大小为 {size}，超过 {limit} 上限。\n大文件请用文件管理器或 scp 直接传输。',
    aiAttachCapError: '文件大小为 {size}，超过 {limit} 附件上限',
    aiAttachDuplicateTitle: '重复文件',
    aiAttachDuplicateBody: '“{name}”（{size}）已在附件列表中。',
    aiAttachFailedTitle: '附件添加失败',
    aiAttachSaveFailedBody: '无法保存“{name}”：{error}',
    aiAttachFailedBody: '“{name}”：{error}',
    aiAttachDirTitle: '无法添加文件夹',
    aiAttachDirBody: '“{name}”是文件夹，请先压缩（zip/tar.gz）再添加压缩包。',
    aiAttachNotFoundTitle: '文件不存在',
    aiAttachNotFoundBody: '“{name}”不存在或无法访问。',
    aiImageLightboxClose: '关闭（Esc）',
    aiBarHide: '隐藏',
    aiBarShow: '显示 AI 输入栏',
    aiModelNone: '未配置模型',
    aiPaneBadge: '窗格 {n}',
    aiPaneSentFrom: '从窗格 {n} 发送',
    aiPaneCrossCall: '跨窗格调用',
    aiPaneDefaultTarget: '默认目标窗格',
    aiTransferWaiting: '等待中…',
    aiTransferCancel: '取消传输',
    aiTransferCompleted: '已完成',
    aiConfirmReject: '拒绝',
    aiConfirmEdit: '编辑',
    aiConfirmAllOccurrences: '（全部匹配项）',
    aiConfirmMoreChars: '…（还有 {n} 个字符）',
    aiWaitDefaultReason: '需要用户输入',
    commonCopied: '已复制!',
    updateAvailable: '新版本 {version} 已发布',
    updateNow: '立即更新',
    updateLater: '稍后',
    updateDownloading: '下载中 {pct}%',
    updateFinishing: '安装中...',
    updateRestarting: '重启中...',
    updateHint: '安装完成后应用将自动重启。',
    updateFailed: '更新失败',
    updateFailedHint: '请稍后重试，或手动下载最新版本。',
    updateModalTitle: '更新至 {version}',
    updateReleaseNotes: '更新说明',
    checkUpdates: '检查更新',
    checkUpdatesUpToDate: '当前已是最新版本',
    checkUpdatesChecking: '正在检查更新…',
    updateModalClose: '关闭',
    hideUpdateIcon: '关闭标题栏更新按钮',
    openFileManager: '打开文件管理器',
    navigateConfirmMsg: '是否打开文件管理器并跳转到 {path}？',
    navigateCancel: '取消',
    navigateConfirm: '打开',
    fileLinkHint: '{mod}+点击打开 {name}',
    fileLinkOpenLocal: '用本机关联程序打开',
    fileLinkOpenInDrawer: '在文件管理器中打开',
    fileLinkDontAskAgain: '不再提示',
    fileLinkLocalConfirmMsg: '是否使用系统默认程序打开 <code>{path}</code>？',
    fileLinkConfirmOpen: '打开',
    fileLinkSkipConfirmSetting: '打开文件链接前确认',
    autoNewSession: '启动时新建本地终端',
    // JumpServer
    jsEditServer: '编辑 JumpServer',
    jsAddServer: '添加 JumpServer',
    jsName: '名称',
    jsBaseUrl: '服务器地址',
    jsSshHost: 'SSH 主机',
    jsSshHostPlaceholder: 'Koko SSH 主机（默认与服务器相同）',
    jsAuthMethod: '认证方式',
    jsAuthPassword: '密码',
    jsAuthToken: 'API 令牌',
    jsApiToken: 'API 令牌',
    jsOrgId: '组织 ID',
    jsOrgIdPlaceholder: '可选，留空使用默认组织',
    jsTestConnection: '测试',
    jsTesting: '测试中…',
    jsTestSuccess: '连接成功',
    jsTestFailed: '连接失败',
    jsSave: '保存',
    jsFieldsRequired: '名称和服务器地址为必填项',
    jsInvalidUrl: 'URL 格式无效',
    jsMfaTitle: '多因素认证',
    jsMfaDesc: '请输入验证码',
    jsMfaCodePlaceholder: '验证码',
    jsMfaVerify: '验证',
    jsAssetBrowser: '资产浏览器',
    jsSearchAssets: '搜索资产…',
    jsLoading: '加载中…',
    jsAllAssets: '全部资产',
    jsAssetsTotal: '个资产',
    jsNoAssets: '未找到资产',
    jsAssetName: '名称',
    jsAssetAddress: '地址',
    jsAssetPlatform: '平台',
    jsAssetComment: '备注',
    jsAssetProtocols: '协议',
    jsAssetActions: '操作',
    jsConnect: '连接',
    jsConnectingAuth: '正在向 JumpServer 认证...',
    jsConnectingToken: '正在获取连接令牌...',
    jsConnectingAsset: '正在连接到 {name}...',
    jsLoadingAccounts: '加载账户中…',
    jsNoAccounts: '没有可用账户',
    jsSelectAccount: '选择账户',
    jsSessionExpired: 'JumpServer 会话已过期',
    jsSessionExpiredDesc: '请重新登录以继续使用资产浏览器。已打开的终端会话不受影响。',
    jsReconnectAction: '重新登录',
    jsLogoutAction: '退出登录',
    jsLogoutConfirm: '退出登录 {name}？已打开的终端会话会保留。',
    jsLoginRequired: '请先重新登录 JumpServer',
    jsReloginFailed: '登录失败，请检查凭据后重试。',
    jsItemActionsTitle: '操作',
    jsCredentialPromptTitle: '登录 JumpServer',
    jsCredentialPromptDesc: '需要凭据以连接 {name}。Keychain 中暂无该连接凭据，请重新输入。',
    jsCredentialPromptUsername: '用户名',
    jsCredentialPromptPassword: '密码',
    jsCredentialPromptApiToken: 'API Token',
    jsCredentialPromptSubmit: '登录',
    jsCredentialStoredHint: '已安全保存，留空可保留原凭据',
    jsCredentialAuthorityChanged: '服务器、账户或代理已变更，请重新输入主凭据后再保存。',
    jsReturnToMainWindow: '返回主窗口',
    homeNewJumpServer: 'JumpServer',
    jsSaveAndConnect: '保存并连接',
    homeSearchPlaceholder: '搜索连接、指令或文档',
    homeGroupDefault: '默认',
    homeGroupUngrouped: '最近',
    homeGroupManage: '管理分组',
    homeGroupNew: '新建分组',
    homeGroupRename: '重命名',
    homeGroupDelete: '删除分组',
    homeGroupDeleteConfirm: '删除该分组？连接将移至最近。',
    homeGroupMoveToGroup: '移动到分组',
    homeGroupNodeCount: '{count} 个节点',
    homeGroupResizeHint: '拖动调整宽度，双击恢复默认宽度',
    homeGroupColor: '颜色',
    homeGroupColorClear: '清除颜色',
    homeGroupCollapse: '折叠',
    homeGroupExpand: '展开',
    homeGroupDuplicate: '复制分组',
    homeGroupNewName: '分组名称',
    homeGroupNameReserved: '以“__”开头的名称由应用保留，请换一个。',
    homeRecentActivity: '最近活跃',
    homeRecentRemove: '从历史记录中移除',
    homeFooterVersion: 'MeTerm v{version}',
    homeFooterGitHub: 'GitHub',
    homeNoConnections: '暂无连接',
    homeSearchHint: '输入关键词搜索连接、网页和命令文档',
    homeSearchConnections: '连接',
    homeSearchWeb: '网络搜索',
    homeSearchTldr: '命令文档',
    homeSearching: '搜索中...',
    homeSearchLoadMore: '加载更多',
    homeSearchPerPage: '/页',
    homeNoResults: '无结果',
    settingsTabAbout: '关于',
    aboutVersion: '版本',
    aboutDescription: '轻量的多会话终端客户端。',
    aboutGitHub: 'GitHub',
    aboutGitee: 'Gitee',
    aboutLicense: '许可协议',
    aboutCopyright: '版权',
    aboutCheckUpdate: '检查更新',
    aboutOpenSource: '开源致谢（排名不分先后）',
    aboutLicenses: '开源致谢',
    aboutAckXterm: '终端模拟器',
    aboutAckTauri: '桌面应用框架',
    aboutAckConpty: 'Windows 伪控制台',
    aboutAckJumpserver: '堡垒机 API',
    aboutAckTldr: '命令文档',
    aboutAckSearxng: '网络搜索 API',
    aboutAckCodemirror: '代码编辑器',
    // tldr & 命令补全
    tldrHelp: '命令帮助',
    tldrEnable: '启用 tldr 命令帮助',
    tldrNoData: '暂无帮助数据，请点击"立即更新"下载。',
    tldrUpdating: '正在更新帮助数据…',
    tldrLastUpdated: '上次更新：{date}',
    tldrUpdateNow: '立即更新',
    tldrPageCount: '已索引 {count} 个命令',
    tldrExamples: '示例',
    cmdCompletionEnable: '启用命令补全（行内提示文字）',
    cmdCompletionHint: '在终端里显示灰色建议，按 → 接受。优先来自你的历史命令，其次是 tldr 命令索引。',
    shellHookEnable: '在 SSH 会话中注入 Shell Hook',
    shellHookHint: '用于记录完整的命令历史（包括 Tab 补全的命令），也让 AI Agent 准确知道命令何时结束、退出码和当前目录。关闭后命令历史只能从键盘输入记录，Agent 只能靠猜测判断命令是否结束。',
    settingsGroupCommandAssist: '命令辅助',
    editorLargeFileWarning: '该文件大小为 {size} MB，打开大文件可能导致卡顿或崩溃。是否继续？',
    editorLargeFileTitle: '大文件警告',
    editorUnsavedChanges: '有未保存的更改，是否丢弃并关闭？',
    editorSaving: '保存中...',
    editorSaved: '已保存',
    editorSaveFailed: '保存失败',
    editorDisconnected: '会话已断开',
    editorReadOnly: '只读',
    editorLoading: '加载中...',
    editorMdPreview: '预览',
    editorMdPreviewOff: '关闭预览',
    editorWordWrap: '换行',
    editorCut: '剪切',
    editorCopy: '复制',
    editorPaste: '粘贴',
    editorSelectAll: '全选',
    editorSave: '保存',
    editorCloseTab: '关闭标签',
    editorFormat: '格式化',
  },
};

const LANGUAGE_KEY = 'meterm-language';

let currentLanguage: Language = 'en';

export function initLanguage(): void {
  const stored = localStorage.getItem(LANGUAGE_KEY) as Language;
  if (stored && translations[stored]) {
    currentLanguage = stored;
  } else {
    const browserLang = navigator.language.slice(0, 2) as Language;
    if (translations[browserLang]) {
      currentLanguage = browserLang;
    }
  }
}

export function setLanguage(lang: Language): void {
  if (translations[lang]) {
    currentLanguage = lang;
    localStorage.setItem(LANGUAGE_KEY, lang);
  }
}

export function getLanguage(): Language {
  return currentLanguage;
}

export function t(key: keyof Translations): string {
  return translations[currentLanguage][key];
}

/** `t()` with `{name}` placeholders filled in; unknown placeholders are left as-is. */
export function tf(key: keyof Translations, vars: Record<string, string | number>): string {
  return t(key).replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
}

export function getAvailableLanguages(): { value: Language; label: string }[] {
  return [
    { value: 'en', label: 'English' },
    { value: 'zh', label: '中文' },
  ];
}

export function getCurrentTranslations(): Translations {
  return translations[currentLanguage];
}
