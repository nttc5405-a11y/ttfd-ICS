/**
 * 共用工具函式。
 * 給之後所有階段共用：JSON 回應、時間格式、UUID、讀寫工作表、LockService 包裝。
 */

function jsonResponse_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function nowIso_() {
  return Utilities.formatDate(new Date(), 'Asia/Taipei', "yyyy-MM-dd'T'HH:mm:ssXXX");
}

function newId_() {
  return Utilities.getUuid();
}

function getSheet_(name) {
  var ss = SpreadsheetApp.getActive();
  var sheet = ss.getSheetByName(name);
  if (!sheet) {
    throw new Error('找不到工作表：' + name);
  }
  return sheet;
}

/**
 * 把工作表所有資料列轉成物件陣列（第一列為欄位名稱），跳過整列空白的資料。
 */
function sheetToObjects_(sheet) {
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  var rows = [];
  for (var i = 1; i < values.length; i++) {
    var row = values[i];
    if (row.join('') === '') continue;
    var obj = {};
    for (var j = 0; j < headers.length; j++) {
      obj[headers[j]] = row[j];
    }
    rows.push(obj);
  }
  return rows;
}

/**
 * 依欄位順序把物件寫成一列，附加到工作表最後。
 */
function appendRow_(sheet, headers, obj) {
  var row = headers.map(function (h) {
    return obj[h] !== undefined ? obj[h] : '';
  });
  sheet.appendRow(row);
}

/**
 * 以 LockService 包住寫入操作，避免多人同時操作互相覆蓋。
 * 最多等待 30 秒取得鎖，取不到就丟出錯誤。
 */
function withLock_(fn) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    return fn();
  } finally {
    lock.releaseLock();
  }
}

function findCaseById_(caseId) {
  var cases = sheetToObjects_(getSheet_('Cases'));
  for (var i = 0; i < cases.length; i++) {
    if (cases[i].case_id === caseId) return cases[i];
  }
  return null;
}

/**
 * 寫一筆工作記事。EventLog 只新增不修改，之後「工作記事」頁面直接依這張表產生內容。
 */
function appendEventLog_(caseId, action, targetId, detail, actor) {
  appendRow_(getSheet_('EventLog'), SHEET_SCHEMAS.EventLog, {
    at: nowIso_(),
    case_id: caseId,
    action: action,
    target_id: targetId || '',
    detail: detail || '',
    actor: actor || ''
  });
}

/**
 * 讀取設定值：個別案件設定優先，沒有才回退到全域設定（case_id 空白），都沒有就回傳 null。
 */
function getSetting_(caseId, key) {
  var rows = sheetToObjects_(getSheet_('Settings'));
  var specific = null;
  var global = null;
  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (r.key !== key) continue;
    if (caseId && r.case_id === caseId) { specific = r.value; }
    if (r.case_id === '') { global = r.value; }
  }
  return specific !== null ? specific : global;
}

/**
 * 讀取布林型設定值，支援 TRUE/FALSE、true/false、1/0（試算表勾選框或手動輸入都吃得下）。
 * 找不到設定時回傳 defaultVal。
 */
function getSettingBool_(caseId, key, defaultVal) {
  var v = getSetting_(caseId, key);
  if (v === null || v === undefined || v === '') return defaultVal;
  return truthy_(v);
}

function truthy_(v) {
  return v === true || v === 'TRUE' || v === 'true' || v === 1 || v === '1';
}

/**
 * 姓名遮罩：王小明 → 王○明；兩個字的姓名（王明）→ 王○；一個字不遮。
 */
function maskName_(name) {
  if (!name) return name;
  var chars = String(name).split('');
  if (chars.length <= 1) return name;
  if (chars.length === 2) return chars[0] + '○';
  for (var i = 1; i < chars.length - 1; i++) chars[i] = '○';
  return chars.join('');
}

/**
 * 判斷這次請求要不要把人名遮罩：檢視模式（role='view'）且該案件開啟了姓名遮罩設定才遮，
 * 管理模式一律看得到真名。
 */
function shouldMaskNames_(caseId, role) {
  if (role !== 'view') return false;
  return getSettingBool_(caseId, 'name_mask_enabled', false);
}

/**
 * 找到符合 matchFn 的第一列，把 patch 裡有的欄位原地更新（只動有列出的欄位，其他不變）。
 * 回傳 true/false 表示有沒有找到列可以更新。呼叫端要自己包 withLock_。
 */
function updateRow_(sheetName, matchFn, patch) {
  var sheet = getSheet_(sheetName);
  var values = sheet.getDataRange().getValues();
  var headers = values[0];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    if (!matchFn(obj)) continue;
    for (var k = 0; k < headers.length; k++) {
      var h = headers[k];
      if (Object.prototype.hasOwnProperty.call(patch, h)) {
        sheet.getRange(i + 1, k + 1).setValue(patch[h]);
      }
    }
    return true;
  }
  return false;
}
