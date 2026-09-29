/**
 * ICS 看板：工作場地（含子場地）。任務相關邏輯在 Tasks.gs。
 * 狀態規則（見 SPEC）：場地 開設→撤收；所有任務結束（非「派遣中」）才可撤收。
 */

/**
 * action: createSite
 * body: { action:'createSite', token, case_id, name, parent_id }
 * parent_id 留空＝主場地；有填則是子場地，parent_id 必須是本案件既有的場地。
 */
function handleCreateSite_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);

  var name = String(body.name || '').trim();
  var parentId = String(body.parent_id || '').trim();
  if (!name) return { ok: false, error: '請輸入場地名稱' };

  if (parentId) {
    var parent = findSiteById_(caseId, parentId);
    if (!parent) return { ok: false, error: '找不到指定的主場地' };
  }

  return withLock_(function () {
    var siteId = newId_();
    appendRow_(getSheet_('Sites'), SHEET_SCHEMAS.Sites, {
      site_id: siteId,
      case_id: caseId,
      parent_id: parentId,
      name: name,
      status: '開設',
      opened_at: nowIso_(),
      closed_at: ''
    });
    appendEventLog_(caseId, 'open_site', siteId, name, auth.operatorName);
    return { ok: true, site_id: siteId };
  });
}

/**
 * action: closeSite（撤收）
 * body: { action:'closeSite', token, case_id, site_id }
 * 場地底下還有「派遣中」的任務就擋下來，需求方（幕僚）要先把任務結束或中止。
 */
function handleCloseSite_(body) {
  var caseId = body.case_id;
  var auth = requireAuth_(body.token, 'admin', caseId);
  var siteId = body.site_id;

  var site = findSiteById_(caseId, siteId);
  if (!site) return { ok: false, error: '找不到此場地' };
  if (site.status === '撤收') return { ok: false, error: '此場地已經撤收過了' };

  var openTaskCount = sheetToObjects_(getSheet_('Tasks')).filter(function (t) {
    return t.case_id === caseId && t.site_id === siteId && t.status === '派遣中';
  }).length;
  if (openTaskCount > 0) {
    return { ok: false, error: '這個場地還有 ' + openTaskCount + ' 個任務進行中，需先結束或中止才能撤收' };
  }

  return withLock_(function () {
    updateRow_('Sites', function (r) {
      return r.case_id === caseId && r.site_id === siteId;
    }, { status: '撤收', closed_at: nowIso_() });
    appendEventLog_(caseId, 'close_site', siteId, site.name, auth.operatorName);
    return { ok: true };
  });
}

/**
 * action: getIcsBoard
 * body: { action:'getIcsBoard', token, case_id }
 * 一次回傳這個案件的場地＋任務（任務內含派遣人員姓名與帶隊官姓名），
 * 讓前端一次組出整個 ICS 看板，不用分好幾次要資料。
 */
function handleGetIcsBoard_(body) {
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
    if (!nameMap.hasOwnProperty(tm.person_id)) return; // 不是這個案件的人，略過
    if (!membersByTask[tm.task_id]) membersByTask[tm.task_id] = [];
    membersByTask[tm.task_id].push({
      person_id: tm.person_id,
      name: nameMap[tm.person_id] || '（未知人員）',
      joined_at: tm.joined_at,
      left_at: tm.left_at
    });
  });

  var tasksOut = tasks.map(function (t) {
    return {
      task_id: t.task_id,
      site_id: t.site_id,
      type: t.type,
      content: t.content,
      leader_id: t.leader_id,
      leader_name: t.leader_id ? (nameMap[t.leader_id] || '（未知人員）') : '',
      status: t.status,
      dispatched_at: t.dispatched_at,
      ended_at: t.ended_at,
      members: membersByTask[t.task_id] || []
    };
  });

  var sitesOut = sites.map(function (s) {
    var activeTaskCount = tasks.filter(function (t) {
      return t.site_id === s.site_id && t.status === '派遣中';
    }).length;
    return {
      site_id: s.site_id,
      parent_id: s.parent_id,
      name: s.name,
      status: s.status,
      opened_at: s.opened_at,
      closed_at: s.closed_at,
      active_task_count: activeTaskCount
    };
  });

  return { ok: true, sites: sitesOut, tasks: tasksOut };
}

function findSiteById_(caseId, siteId) {
  var sites = sheetToObjects_(getSheet_('Sites'));
  for (var i = 0; i < sites.length; i++) {
    if (sites[i].case_id === caseId && sites[i].site_id === siteId) return sites[i];
  }
  return null;
}
