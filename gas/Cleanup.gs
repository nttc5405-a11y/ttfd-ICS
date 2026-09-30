/**
 * 批次刪除案件（含所有關聯資料）。
 *
 * 刻意設計成「只能在 Apps Script 編輯器手動執行」，不透過網頁 API 開放——這是永久刪除、
 * 試算表沒有回收桶等級的救援機制，不適合做成一顆隨時能按的網頁按鈕（怕誤觸、怕被冒用管理碼
 * 遠端亂刪）。要清測試資料時，照下面兩步操作：
 *
 *   1. 先執行 devListCasesForCleanup()，看執行紀錄列出所有案件的 case_id、名稱、狀態。
 *   2. 把要刪除的 case_id 複製貼進 devDeleteCases() 裡的 caseIdsToDelete 陣列（一行一個），
 *      確認清單無誤後再執行 devDeleteCases()。陣列預設是空的，空陣列執行不會刪除任何東西。
 *
 * 會清掉的資料：Cases、Settings（該案件的個別設定）、CaseChecklist、Personnel、Sites、Tasks、
 * TaskMembers（透過 task_id 對應，這張表本身沒有 case_id 欄位）、Maps、EventLog、Marquee。
 * 不會自動清的：Drive 裡上傳過的圖資檔案（執行紀錄會提醒，需要的話自己去 Drive 手動刪，
 * 或看下面 devDeleteCases 的圖資刪除選項）。
 */

/**
 * 手動執行：列出所有案件方便對照，找出要刪除的 case_id。
 */
function devListCasesForCleanup() {
  var cases = sheetToObjects_(getSheet_('Cases'));
  if (cases.length === 0) {
    Logger.log('目前沒有任何案件。');
    return;
  }
  cases.forEach(function (c, i) {
    Logger.log((i + 1) + '. [' + c.status + '] ' + c.name + '（' + c.category + '，建立於 ' + c.created_at + '）');
    Logger.log('   case_id = ' + c.case_id);
  });
  Logger.log('共 ' + cases.length + ' 筆。要刪除哪幾筆，把對應的 case_id 複製貼進 devDeleteCases() 函式裡的');
  Logger.log('caseIdsToDelete 陣列，確認清單無誤後再執行 devDeleteCases()。');
}

/**
 * 手動執行：真正刪除 caseIdsToDelete 陣列裡列出的案件與所有關聯資料。
 * ⚠️ 這個動作無法復原，執行前務必再三確認陣列裡的 case_id 都是你真的要刪的。
 */
function devDeleteCases() {
  // ↓↓↓ 把要刪除的 case_id 貼在這裡，一個字串一行，用 devListCasesForCleanup() 的輸出對照 ↓↓↓
  var caseIdsToDelete = [
    // '18a073c8-a5c4-46c7-bf3c-285f76f31fe3', // 範例：【測試】批次報到驗收用
  ];
  // 要不要連同 Drive 裡這個案件上傳過的圖資資料夾一起丟進垃圾桶（可從 Drive 垃圾桶復原）
  var alsoTrashDriveFolder = true;
  // ↑↑↑ 改完上面兩個變數，確認無誤後再執行 ↑↑↑

  if (caseIdsToDelete.length === 0) {
    Logger.log('caseIdsToDelete 是空陣列，沒有刪除任何東西。');
    Logger.log('請先執行 devListCasesForCleanup() 查看案件清單，把要刪除的 case_id 貼進這個函式的陣列裡再重新執行。');
    return;
  }

  var sheetsWithCaseId = ['Cases', 'Settings', 'CaseChecklist', 'Personnel', 'Sites', 'Tasks', 'Maps', 'EventLog', 'Marquee'];

  withLock_(function () {
    caseIdsToDelete.forEach(function (caseId) {
      var caseRow = findCaseById_(caseId);
      var caseName = caseRow ? caseRow.name : '（找不到，可能已經刪過或 case_id 打錯）';

      // TaskMembers 沒有 case_id 欄位，要先收集這個案件底下所有 task_id 才能對應刪除
      var taskIds = sheetToObjects_(getSheet_('Tasks'))
        .filter(function (t) { return t.case_id === caseId; })
        .map(function (t) { return t.task_id; });

      var taskMembersDeleted = deleteRowsWhere_('TaskMembers', function (r) {
        return taskIds.indexOf(r.task_id) !== -1;
      });

      var totalDeleted = taskMembersDeleted;
      sheetsWithCaseId.forEach(function (sheetName) {
        totalDeleted += deleteRowsWhere_(sheetName, function (r) { return r.case_id === caseId; });
      });

      Logger.log('已刪除「' + caseName + '」（' + caseId + '），共 ' + totalDeleted +
        ' 列資料（含 TaskMembers ' + taskMembersDeleted + ' 列）。');

      if (alsoTrashDriveFolder) {
        try {
          var root = getOrCreateMapsRootFolder_();
          var it = root.getFoldersByName(caseId);
          if (it.hasNext()) {
            it.next().setTrashed(true);
            Logger.log('  → 這個案件的 Drive 圖資資料夾已丟進垃圾桶（Drive 垃圾桶可復原）。');
          }
        } catch (e) {
          Logger.log('  → Drive 圖資資料夾處理失敗：' + e.message + '（不影響試算表資料已刪除的結果）。');
        }
      }
    });
  });

  Logger.log('全部完成。');
}

/**
 * 刪掉 sheetName 裡符合 predicate 的所有列，回傳刪了幾列。由後往前刪，避免刪除中途行號跑掉。
 */
function deleteRowsWhere_(sheetName, predicate) {
  var sheet = getSheet_(sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return 0;

  var headers = values[0];
  var rowsToDelete = [];
  for (var i = 1; i < values.length; i++) {
    var obj = {};
    for (var j = 0; j < headers.length; j++) obj[headers[j]] = values[i][j];
    if (predicate(obj)) rowsToDelete.push(i + 1); // 試算表列號從 1 開始，第 1 列是標題
  }

  rowsToDelete.sort(function (a, b) { return b - a; }); // 由大到小，先刪下面的列才不會影響上面列號
  rowsToDelete.forEach(function (rowNum) { sheet.deleteRow(rowNum); });
  return rowsToDelete.length;
}
