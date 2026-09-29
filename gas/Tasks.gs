/**
 * ICS 看板：任務（建立、增減人員、結束）。
 * 狀態規則（見 SPEC）：任務 派遣中→完成／中止；未填 ended_at 即為持續作業。
 * 重複派遣警告：派遣時若該員已在其他任務中，回傳 need_confirm 讓前端跳警告，
 * 使用者確認後帶 force:true 重送，同時會把該員從原任務調出（填 left_at）。
 */

var TASK_TYPES = ['搜索', '救援'];

/**
 * action: createTask
 * body: { action:'createTask', token, case_id, site_id, type, content, leader_id, member_ids, force }
 */
function handleCreateTask_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);

  var siteId = body.site_id;
  var type = body.type;
  var content = String(body.content || '').trim();
  var leaderId = String(body.leader_id || '').trim();
  var memberIds = Array.isArray(body.member_ids) ? body.member_ids.slice() : [];
  var force = !!body.force;

  if (TASK_TYPES.indexOf(type) === -1) return { ok: false, error: '任務類型需為搜索或救援' };
  if (!content) return { ok: false, error: '請輸入任務內容' };

  var site = findSiteById_(caseId, siteId);
  if (!site) return { ok: false, error: '找不到此場地' };
  if (site.status !== '開設') return { ok: false, error: '此場地已撤收，不能建立新任務' };

  if (leaderId && memberIds.indexOf(leaderId) === -1) memberIds.push(leaderId);
  memberIds = memberIds.filter(function (id, idx) { return id && memberIds.indexOf(id) === idx; });

  return withLock_(function () {
    var conflicts = findDispatchConflicts_(memberIds, caseId);
    if (conflicts.length > 0 && !force) {
      return { ok: false, need_confirm: true, error: '部分人員已在其他任務中', conflicts: conflicts };
    }

    var taskId = newId_();
    appendRow_(getSheet_('Tasks'), SHEET_SCHEMAS.Tasks, {
      task_id: taskId,
      case_id: caseId,
      site_id: siteId,
      type: type,
      content: content,
      leader_id: leaderId,
      status: '派遣中',
      dispatched_at: nowIso_(),
      ended_at: ''
    });

    transferOutConflicts_(conflicts);

    var tmSheet = getSheet_('TaskMembers');
    memberIds.forEach(function (pid) {
      appendRow_(tmSheet, SHEET_SCHEMAS.TaskMembers, {
        id: newId_(), task_id: taskId, person_id: pid, joined_at: nowIso_(), left_at: ''
      });
    });

    appendEventLog_(caseId, 'create_task', taskId, type + '：' + content, auth.operatorName);
    return { ok: true, task_id: taskId };
  });
}

/**
 * action: updateTaskMembers（任務進行中增減人員）
 * body: { action:'updateTaskMembers', token, case_id, task_id, add:[person_id...], remove:[person_id...], force }
 */
function handleUpdateTaskMembers_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);

  var taskId = body.task_id;
  var addIds = Array.isArray(body.add) ? body.add.filter(function (id) { return id; }) : [];
  var removeIds = Array.isArray(body.remove) ? body.remove.filter(function (id) { return id; }) : [];
  var force = !!body.force;

  var task = findTaskById_(caseId, taskId);
  if (!task) return { ok: false, error: '找不到此任務' };
  if (task.status !== '派遣中') return { ok: false, error: '任務已結束，不能異動人員' };

  return withLock_(function () {
    if (addIds.length > 0) {
      var conflicts = findDispatchConflicts_(addIds, caseId).filter(function (c) {
        return c.current_task_id !== taskId;
      });
      if (conflicts.length > 0 && !force) {
        return { ok: false, need_confirm: true, error: '部分人員已在其他任務中', conflicts: conflicts };
      }
      transferOutConflicts_(conflicts);

      var tmSheet = getSheet_('TaskMembers');
      addIds.forEach(function (pid) {
        appendRow_(tmSheet, SHEET_SCHEMAS.TaskMembers, {
          id: newId_(), task_id: taskId, person_id: pid, joined_at: nowIso_(), left_at: ''
        });
      });
    }

    removeIds.forEach(function (pid) {
      updateRow_('TaskMembers', function (r) {
        return r.task_id === taskId && r.person_id === pid && !r.left_at;
      }, { left_at: nowIso_() });
    });

    if (addIds.length > 0 || removeIds.length > 0) {
      appendEventLog_(caseId, 'update_task_members', taskId, '+' + addIds.length + ' / -' + removeIds.length, auth.operatorName);
    }

    return { ok: true };
  });
}

/**
 * action: endTask（完成／中止）
 * body: { action:'endTask', token, case_id, task_id, status }
 * 任務結束時，這個任務底下所有還沒填 left_at 的 TaskMembers 一併補上結束時間，
 * 不然人員狀態（靠 TaskMembers 推算）會卡在「任務中」出不來。
 */
function handleEndTask_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);
  var taskId = body.task_id;
  var status = body.status;

  if (['完成', '中止'].indexOf(status) === -1) return { ok: false, error: '狀態需為完成或中止' };

  var task = findTaskById_(caseId, taskId);
  if (!task) return { ok: false, error: '找不到此任務' };
  if (task.status !== '派遣中') return { ok: false, error: '此任務已經結束過了' };

  return withLock_(function () {
    var endedAt = nowIso_();
    updateRow_('Tasks', function (r) {
      return r.case_id === caseId && r.task_id === taskId;
    }, { status: status, ended_at: endedAt });

    var sheet = getSheet_('TaskMembers');
    var values = sheet.getDataRange().getValues();
    var headers = values[0];
    var taskIdCol = headers.indexOf('task_id');
    var leftAtCol = headers.indexOf('left_at');
    for (var i = 1; i < values.length; i++) {
      if (values[i][taskIdCol] === taskId && !values[i][leftAtCol]) {
        sheet.getRange(i + 1, leftAtCol + 1).setValue(endedAt);
      }
    }

    appendEventLog_(caseId, status === '完成' ? 'task_done' : 'task_abort', taskId, task.type + '：' + task.content, auth.operatorName);
    return { ok: true };
  });
}

/**
 * 找出 memberIds 裡「目前正在其他未結束任務中」的人，回傳每人所在的任務資訊，
 * 給前端組出警告文字（該員已在「XX：YY」任務中）。
 */
function findDispatchConflicts_(memberIds, caseId) {
  if (memberIds.length === 0) return [];
  var openMembers = sheetToObjects_(getSheet_('TaskMembers')).filter(function (tm) {
    return !tm.left_at && memberIds.indexOf(tm.person_id) !== -1;
  });
  if (openMembers.length === 0) return [];

  var tasksById = {};
  sheetToObjects_(getSheet_('Tasks')).forEach(function (t) { tasksById[t.task_id] = t; });
  var nameMap = personnelNameMap_(caseId);

  return openMembers.map(function (tm) {
    var t = tasksById[tm.task_id];
    return {
      person_id: tm.person_id,
      name: nameMap[tm.person_id] || '（未知人員）',
      current_task_id: tm.task_id,
      current_task_content: t ? (t.type + '：' + t.content) : '（未知任務）'
    };
  });
}

/**
 * 使用者已確認要「從原任務調出」：把衝突名單在原任務的 TaskMembers 列填上 left_at。
 */
function transferOutConflicts_(conflicts) {
  conflicts.forEach(function (c) {
    updateRow_('TaskMembers', function (r) {
      return r.person_id === c.person_id && r.task_id === c.current_task_id && !r.left_at;
    }, { left_at: nowIso_() });
  });
}

function findTaskById_(caseId, taskId) {
  var tasks = sheetToObjects_(getSheet_('Tasks'));
  for (var i = 0; i < tasks.length; i++) {
    if (tasks[i].case_id === caseId && tasks[i].task_id === taskId) return tasks[i];
  }
  return null;
}
