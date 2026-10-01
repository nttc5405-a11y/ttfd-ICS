/**
 * 工作記事：把場地開設/撤收、任務派遣/結束、人員報到/簽退、任務中途增減人員、狀況回報
 * 整理成依時間排序的時間軸。資料來源是目前的 Sites/Tasks/TaskMembers/Personnel/Reports
 * 這幾張表的現況，不解析 EventLog 文字內容（EventLog 的 detail 多半只是給人看的摘要字串，
 * 不保證好剖析；這裡能從結構化欄位重建的，就不去動 EventLog）。
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

  // 人員報到／簽退：直接從 Personnel 的 checkin_at／left_at 重建，不解析 EventLog。
  // 同一時間（同一次單筆或批次操作）的人合併成一筆紀錄，不然批次報到 10 個人會洗出 10 列，
  // 畫面會很冗長——用「時間完全相同」當作「同一批」的判斷依據。
  var checkinGroups = {};
  var checkoutGroups = {};
  sheetToObjects_(getSheet_('Personnel')).filter(function (p) { return p.case_id === caseId; }).forEach(function (p) {
    var displayName = nameMap[p.person_id] || p.name;
    var label = displayName + (p.unit ? '（' + p.unit + '）' : '');
    if (!checkinGroups[p.checkin_at]) checkinGroups[p.checkin_at] = [];
    checkinGroups[p.checkin_at].push(label);
    if (p.left_at) {
      if (!checkoutGroups[p.left_at]) checkoutGroups[p.left_at] = [];
      checkoutGroups[p.left_at].push(label);
    }
  });
  Object.keys(checkinGroups).forEach(function (at) {
    entries.push({ at: at, type: 'personnel_checkin', site_name: '', names: checkinGroups[at] });
  });
  Object.keys(checkoutGroups).forEach(function (at) {
    entries.push({ at: at, type: 'personnel_checkout', site_name: '', names: checkoutGroups[at] });
  });

  // 任務進行中的增減人員：只挑「跟任務本身的派遣/結束時間不同」的異動，排除掉建立任務當下
  // 的初始派遣、跟任務結束時自動收尾那批人（這兩種已經由 task_start／task_end 顯示過了）。
  // 同一次「增減人員」操作一次加/移除多人時，同一任務＋同一時間的合併成一筆。
  var addGroups = {};
  var removeGroups = {};
  taskMembers.forEach(function (tm) {
    var task = taskById[tm.task_id];
    if (!task || !nameMap.hasOwnProperty(tm.person_id)) return;
    var memberName = nameMap[tm.person_id];

    if (tm.joined_at !== task.dispatched_at) {
      var addKey = tm.task_id + '|' + tm.joined_at;
      if (!addGroups[addKey]) addGroups[addKey] = { at: tm.joined_at, task: task, names: [] };
      addGroups[addKey].names.push(memberName);
    }
    if (tm.left_at && tm.left_at !== task.ended_at) {
      var removeKey = tm.task_id + '|' + tm.left_at;
      if (!removeGroups[removeKey]) removeGroups[removeKey] = { at: tm.left_at, task: task, names: [] };
      removeGroups[removeKey].names.push(memberName);
    }
  });
  Object.keys(addGroups).forEach(function (key) {
    var g = addGroups[key];
    entries.push({
      at: g.at, type: 'task_member_add',
      site_name: siteNameById[g.task.site_id] || '（未知場地）',
      task_content: '[' + g.task.type + '] ' + g.task.content,
      names: g.names
    });
  });
  Object.keys(removeGroups).forEach(function (key) {
    var g = removeGroups[key];
    entries.push({
      at: g.at, type: 'task_member_remove',
      site_name: siteNameById[g.task.site_id] || '（未知場地）',
      task_content: '[' + g.task.type + '] ' + g.task.content,
      names: g.names
    });
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
