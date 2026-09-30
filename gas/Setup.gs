/**
 * 工作表初始化。
 *
 * 部署步驟：把這幾個 .gs 檔貼進 Apps Script 編輯器後，
 * 先手動執行一次 initializeSpreadsheet()，再視需要執行 devCreateTestCase() 測試驗證流程。
 * 詳細步驟見「部署與測試指南.md」。
 */

var SHEET_SCHEMAS = {
  Cases: ['case_id', 'category', 'name', 'status', 'created_at', 'closed_at', 'view_hash', 'admin_hash', 'version'],
  Settings: ['case_id', 'key', 'value'],
  Checklists: ['category', 'group', 'item', 'sort', 'link'],
  CaseChecklist: ['case_id', 'item', 'done', 'done_by', 'done_at'],
  Personnel: ['person_id', 'case_id', 'unit', 'sub_unit', 'name', 'specialty', 'checkin_zone', 'checkin_at', 'left_at'],
  Sites: ['site_id', 'case_id', 'parent_id', 'name', 'status', 'opened_at', 'closed_at'],
  Tasks: ['task_id', 'case_id', 'site_id', 'type', 'content', 'leader_id', 'status', 'dispatched_at', 'ended_at'],
  TaskMembers: ['id', 'task_id', 'person_id', 'joined_at', 'left_at'],
  Maps: ['map_id', 'case_id', 'site_id', 'name', 'drive_id', 'created_at'],
  EventLog: ['at', 'case_id', 'action', 'target_id', 'detail', 'actor'],
  Marquee: ['case_id', 'content', 'enabled', 'sort']
};

/**
 * 手動執行一次：建立所有工作表與標題列（已存在的工作表不會被清空，只補上/修正標題），
 * 設定試算表時區為 Asia/Taipei，並產生驗證碼用的 salt。
 * 可重複執行，不會破壞既有資料（冪等）。
 */
function initializeSpreadsheet() {
  var ss = SpreadsheetApp.getActive();
  ss.setSpreadsheetTimeZone('Asia/Taipei');

  var sheetNames = Object.keys(SHEET_SCHEMAS);
  sheetNames.forEach(function (name) {
    var headers = SHEET_SCHEMAS[name];
    var sheet = ss.getSheetByName(name);
    if (!sheet) {
      sheet = ss.insertSheet(name);
    }
    var firstRow = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
    var needsHeader = headers.some(function (h, i) { return firstRow[i] !== h; });
    if (needsHeader) {
      sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    }
    sheet.setFrozenRows(1);
  });

  // 刪除 Google 試算表預設建立的空白工作表（通常叫「工作表1」）
  var defaultSheet = ss.getSheetByName('工作表1') || ss.getSheetByName('Sheet1');
  if (defaultSheet && sheetNames.indexOf(defaultSheet.getName()) === -1) {
    ss.deleteSheet(defaultSheet);
  }

  getSalt_(); // 確保 AUTH_SALT 已產生

  Logger.log('初始化完成，共 ' + sheetNames.length + ' 張工作表：' + sheetNames.join('、'));
}

/**
 * 測試用：建立一筆測試案件，供 Phase 1 驗證 verify/token 流程。
 * 手動在編輯器執行一次，執行後到「執行紀錄」（Ctrl+Enter 或選單「檢視 > 執行紀錄」）
 * 複製 case_id、檢視碼、管理碼 —— 明碼只會在這裡出現一次，試算表裡只存雜湊值。
 *
 * 正式的「建立案件」功能屬於第 2 階段（首頁），這裡只是暫時的測試資料。
 */
function devCreateTestCase() {
  var viewCode = '123456';
  var adminCode = 'admin888';
  var salt = getSalt_();

  var caseId = newId_();
  var row = {
    case_id: caseId,
    category: '火警',
    name: '測試案件（Phase1）',
    status: '進行中',
    created_at: nowIso_(),
    closed_at: '',
    view_hash: hashCode_(viewCode, salt),
    admin_hash: hashCode_(adminCode, salt),
    version: 1
  };

  withLock_(function () {
    appendRow_(getSheet_('Cases'), SHEET_SCHEMAS.Cases, row);
  });

  Logger.log('已建立測試案件，請妥善保存以下資訊（僅此次顯示明碼）：');
  Logger.log('case_id = ' + caseId);
  Logger.log('檢視碼 = ' + viewCode);
  Logger.log('管理碼 = ' + adminCode);
}

/**
 * 測試用：在 Checklists 工作表塞入四個類別的範例檢核表範本，供 Phase 3 測試「建案時複製範本」
 * 與「勾選檢核表」的流程。這些只是範例文字，方便先跑通機制，正式內容請直接在 Checklists
 * 工作表修改（category、group、item、sort、link 五欄，group 固定用「裝備」「表單」「注意事項」三種；
 * link 留空就好，要放超連結的項目才填，畫面上會把該項目文字變成可點擊的連結）。
 * 可重複執行，每次執行前會先清空 Checklists 既有資料再重新寫入，避免重複。
 */
function devSeedChecklistTemplates() {
  var rows = [
    // 山域
    ['山域', '裝備', '（範例）無線電與備用電池', 1],
    ['山域', '裝備', '（範例）GPS 定位器', 2],
    ['山域', '裝備', '（範例）緊急醫療包', 3],
    ['山域', '表單', '（範例）出勤人員簽到表', 1],
    ['山域', '表單', '（範例）搜索範圍分配圖', 2],
    ['山域', '注意事項', '（範例）落石與邊坡滑動風險', 1],
    ['山域', '注意事項', '（範例）失溫預防與保暖裝備確認', 2],
    ['山域', '注意事項', '（範例）通訊死角回報方式', 3],
    // 水域
    ['水域', '裝備', '（範例）救生衣', 1],
    ['水域', '裝備', '（範例）浮具與繩索', 2],
    ['水域', '裝備', '（範例）水下通訊設備', 3],
    ['水域', '表單', '（範例）出勤人員簽到表', 1],
    ['水域', '注意事項', '（範例）水流與水溫評估', 1],
    ['水域', '注意事項', '（範例）能見度與下潛時間管制', 2],
    // 火警
    ['火警', '裝備', '（範例）空氣呼吸器與備用氣瓶', 1],
    ['火警', '裝備', '（範例）水線布署', 2],
    ['火警', '裝備', '（範例）破壞器材', 3],
    ['火警', '表單', '（範例）出勤人員簽到表', 1],
    ['火警', '注意事項', '（範例）建築結構安全評估', 1],
    ['火警', '注意事項', '（範例）閃燃／回燃風險', 2],
    // 化災
    ['化災', '裝備', '（範例）化學防護衣', 1],
    ['化災', '裝備', '（範例）偵測儀器', 2],
    ['化災', '裝備', '（範例）洗消設備', 3],
    ['化災', '表單', '（範例）出勤人員簽到表', 1],
    ['化災', '注意事項', '（範例）物質辨識與 SDS 確認', 1],
    ['化災', '注意事項', '（範例）風向評估與疏散半徑', 2]
  ];

  var sheet = getSheet_('Checklists');
  var headers = SHEET_SCHEMAS.Checklists;
  // rows 目前只寫了 category/group/item/sort 四欄，補上第五欄 link（範例先留空，
  // 要示範超連結的話可以之後直接在 Checklists 工作表的 link 欄位貼網址）。
  var paddedRows = rows.map(function (r) { return r.concat(['']); });

  withLock_(function () {
    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.getRange(2, 1, lastRow - 1, headers.length).clearContent();
    }
    sheet.getRange(2, 1, paddedRows.length, headers.length).setValues(paddedRows);
  });

  Logger.log('已寫入 ' + rows.length + ' 筆範例檢核表範本，涵蓋山域/水域/火警/化災四個類別。');
  Logger.log('這些是測試用範例文字，正式使用前請直接在 Checklists 工作表修改成實際內容。');
}
