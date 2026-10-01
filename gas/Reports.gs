/**
 * 狀況回報：現場發現狀況（例如「某任務中發現患者」）的即時紀錄，分「一般」「緊急」兩級。
 * 可以綁一個任務（task_id）、綁一個場地（site_id，不綁任務時表示整個場地的狀況）、
 * 或都不綁（case_id 層級的一般回報）。緊急回報會讓前端對應的任務/場地卡片顯示紅色徽章，
 * 也會併入工作記事時間軸，不是另外一張獨立畫面。
 */

var REPORT_LEVELS = ['一般', '緊急'];

/**
 * action: createReport
 * body: { action:'createReport', token, case_id, site_id, task_id, level, content }
 * site_id／task_id 都可留空；留空 task_id 但有 site_id 表示「整個場地」的回報。
 */
function handleCreateReport_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);

  var content = String(body.content || '').trim();
  if (!content) return { ok: false, error: '請輸入回報內容' };

  var level = REPORT_LEVELS.indexOf(body.level) !== -1 ? body.level : '一般';
  var siteId = String(body.site_id || '').trim();
  var taskId = String(body.task_id || '').trim();

  if (siteId && !findSiteById_(caseId, siteId)) return { ok: false, error: '找不到指定的場地' };
  if (taskId && !findTaskById_(caseId, taskId)) return { ok: false, error: '找不到指定的任務' };

  return withLock_(function () {
    var reportId = newId_();
    appendRow_(getSheet_('Reports'), SHEET_SCHEMAS.Reports, {
      report_id: reportId,
      case_id: caseId,
      site_id: siteId,
      task_id: taskId,
      level: level,
      content: content,
      reported_by: auth.operatorName,
      reported_at: nowIso_()
    });
    appendEventLog_(caseId, 'status_report', reportId, '[' + level + '] ' + content, auth.operatorName);
    return { ok: true, report_id: reportId };
  });
}

/**
 * 這個案件全部的狀況回報（給 getIcsBoard 一起附帶回傳用，前端不用為了算紅色徽章另外打一次 API）。
 */
function reportsForCase_(caseId) {
  return sheetToObjects_(getSheet_('Reports')).filter(function (r) { return r.case_id === caseId; });
}
