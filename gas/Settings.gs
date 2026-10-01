/**
 * 設定頁：個別案件層級的功能開關（全域設定目前仍直接在 Settings 工作表手動編輯，
 * case_id 留空的列就是全域，見部署指南）。
 * 開關清單（對應 SPEC 設定頁）：
 * - view_code_enabled / admin_code_enabled：檢視碼／管理碼是否還能用來進入這個案件
 * - case_view_enabled：整個案件要不要能被檢視／進入（最上層總開關）
 * - marquee_enabled：這個案件底下的跑馬燈公告要不要顯示
 * - name_mask_enabled：檢視模式下人名要不要遮罩（王○明）
 * - overdue_hours：山域任務逾時警示時數（數字，預設 4）
 */

var DEFAULT_OVERDUE_HOURS = 4;

/**
 * action: getCaseSettings
 * body: { action:'getCaseSettings', token, case_id }
 * 檢視/管理模式都能讀（畫面上檢視模式看到的設定頁是唯讀），存檔要 admin。
 * 回傳也附帶 case_times（起訖時間＋狀態），給設定頁的「案件時間」卡片用，
 * 不用為了這個再多打一次 API。
 */
function handleGetCaseSettings_(body) {
  var caseId = body.case_id;
  requireAuth_(body.token, 'view', caseId);

  var caseRow = findCaseById_(caseId);
  if (!caseRow) return { ok: false, error: '找不到此案件' };

  var settings = {
    view_code_enabled: getSettingBool_(caseId, 'view_code_enabled', true),
    admin_code_enabled: getSettingBool_(caseId, 'admin_code_enabled', true),
    case_view_enabled: getSettingBool_(caseId, 'case_view_enabled', true),
    marquee_enabled: getSettingBool_(caseId, 'marquee_enabled', true),
    name_mask_enabled: getSettingBool_(caseId, 'name_mask_enabled', false),
    overdue_hours: Number(getSetting_(caseId, 'overdue_hours')) || DEFAULT_OVERDUE_HOURS
  };

  var marqueeItems = sheetToObjects_(getSheet_('Marquee'))
    .filter(function (m) { return m.case_id === caseId; })
    .sort(function (a, b) { return (Number(a.sort) || 0) - (Number(b.sort) || 0); })
    .filter(function (m) { return truthy_(m.enabled); })
    .map(function (m) { return { content: m.content }; });

  var caseTimes = { status: caseRow.status, created_at: caseRow.created_at, closed_at: caseRow.closed_at };

  return { ok: true, settings: settings, marquee: marqueeItems, case_times: caseTimes };
}

/**
 * action: updateCaseSettings
 * body: { action:'updateCaseSettings', token, case_id, settings:{...部分或全部上面那些鍵} }
 */
function handleUpdateCaseSettings_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);
  var patch = body.settings || {};

  var boolKeys = ['view_code_enabled', 'admin_code_enabled', 'case_view_enabled', 'marquee_enabled', 'name_mask_enabled'];

  return withLock_(function () {
    boolKeys.forEach(function (key) {
      if (Object.prototype.hasOwnProperty.call(patch, key)) {
        setCaseSetting_(caseId, key, patch[key] ? 'TRUE' : 'FALSE');
      }
    });
    if (Object.prototype.hasOwnProperty.call(patch, 'overdue_hours')) {
      var hours = Number(patch.overdue_hours);
      if (!isNaN(hours) && hours > 0) {
        setCaseSetting_(caseId, 'overdue_hours', String(hours));
      }
    }
    appendEventLog_(caseId, 'update_settings', caseId, '案件設定已更新', auth.operatorName);
    return { ok: true };
  });
}

/**
 * 寫入/更新一筆案件層級設定（Settings：case_id=caseId, key=key）。沒有就新增，有就原地更新。
 */
function setCaseSetting_(caseId, key, value) {
  var updated = updateRow_('Settings', function (r) {
    return r.case_id === caseId && r.key === key;
  }, { value: value });
  if (!updated) {
    appendRow_(getSheet_('Settings'), SHEET_SCHEMAS.Settings, { case_id: caseId, key: key, value: value });
  }
}

/**
 * 進入案件前檢查：這個案件（或這個角色的代碼）有沒有被設定頁停用。
 * 回傳 null 表示可以放行，回傳字串就是要擋下的錯誤訊息。
 */
function checkCaseAccessAllowed_(caseId, role) {
  if (!getSettingBool_(caseId, 'case_view_enabled', true)) {
    return '此案件目前已停用檢視功能';
  }
  if (role === 'view' && !getSettingBool_(caseId, 'view_code_enabled', true)) {
    return '檢視碼目前已停用';
  }
  if (role === 'admin' && !getSettingBool_(caseId, 'admin_code_enabled', true)) {
    return '管理碼目前已停用';
  }
  return null;
}
