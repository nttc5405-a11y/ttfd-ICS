/**
 * 工作記事：把場地開設/撤收、任務派遣/結束整理成依時間排序的時間軸。
 * 資料來源是目前的 Sites/Tasks/TaskMembers（這些資料本身就是靠 EventLog 對應的動作寫入的，
 * 這裡直接從現況重建時間軸，不用另外解析 EventLog 文字內容）。
 */

/**
 * action: getWorkLog
 * body: { action:'getWorkLog', token, case_id }
 */
function handleGetWorkLog_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'view', caseId);

  var sites = sheetToObjects_(getSheet_('Sites')).filter(function (s) { return s.case_id === caseId; });
  var tasks = sheetToObjects_(getSheet_('Tasks')).filter(function (t) { return t.case_id === caseId; });
  var taskMembers = sheetToObjects_(getSheet_('TaskMembers'));
  var nameMap = personnelNameMap_(caseId);
  if (shouldMaskNames_(caseId, auth.role)) {
    Object.keys(nameMap).forEach(function (pid) { nameMap[pid] = maskName_(nameMap[pid]); });
  }

  var membersByTask = {};
  taskMembers.forEach(function (tm) {
    if (!nameMap.hasOwnProperty(tm.person_id)) return;
    if (!membersByTask[tm.task_id]) membersByTask[tm.task_id] = [];
    membersByTask[tm.task_id].push(nameMap[tm.person_id] || '（未知人員）');
  });

  var entries = [];

  sites.forEach(function (s) {
    entries.push({ at: s.opened_at, type: 'site_open', site_name: s.name });
    if (s.closed_at) {
      entries.push({ at: s.closed_at, type: 'site_close', site_name: s.name });
    }
  });

  var siteNameById = {};
  sites.forEach(function (s) { siteNameById[s.site_id] = s.name; });

  var taskById = {};
  tasks.forEach(function (t) { taskById[t.task_id] = t; });

  tasks.forEach(function (t) {
    var members = membersByTask[t.task_id] || [];
    var siteName = siteNameById[t.site_id] || '（未知場地）';

    entries.push({
      at: t.dispatched_at,
      type: 'task_start',
      site_name: siteName,
      task_type: t.type,
      task_content: t.content,
      members: members
    });

    if (t.ended_at) {
      entries.push({
        at: t.ended_at,
        type: 'task_end',
        site_name: siteName,
        task_type: t.type,
        task_content: t.content,
        members: members,
        status: t.status
      });
    }
  });

  reportsForCase_(caseId).forEach(function (r) {
    var task = r.task_id ? taskById[r.task_id] : null;
    var siteId = r.site_id || (task ? task.site_id : '');
    entries.push({
      at: r.reported_at,
      type: 'status_report',
      level: r.level,
      site_name: siteId ? (siteNameById[siteId] || '（未知場地）') : '（未綁定場地）',
      task_content: task ? ('[' + task.type + '] ' + task.content) : '',
      report_content: r.content,
      reported_by: r.reported_by
    });
  });

  entries.sort(function (a, b) { return a.at < b.at ? -1 : (a.at > b.at ? 1 : 0); });

  return { ok: true, entries: entries };
}
