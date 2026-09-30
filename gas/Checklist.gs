/**
 * 檢核表與注意事項。
 * 範本存在 Checklists（依 category，直接在試算表編輯），建案時複製一份到 CaseChecklist
 * （見 Cases.gs 的 handleCreateCase_）。這裡只處理「讀取合併後的檢核表」與「勾選/取消勾選」。
 */

var CHECKLIST_GROUP_ORDER = ['裝備', '表單', '注意事項'];

function checklistGroupRank_(g) {
  var idx = CHECKLIST_GROUP_ORDER.indexOf(g);
  return idx === -1 ? 99 : idx;
}

/**
 * action: getCaseChecklist
 * body: { action:'getCaseChecklist', token, case_id }
 * 把 Checklists 範本（group/item/sort）跟 CaseChecklist 的勾選狀態合併，
 * 依 group（裝備→表單→注意事項→其他）再依 sort 排序回傳。
 */
function handleGetCaseChecklist_(body) {
  var caseId = body.case_id;
  requireAuth_(body.token, 'view', caseId);

  var caseRow = findCaseById_(caseId);
  if (!caseRow) return { ok: false, error: '找不到此案件' };

  var templates = sheetToObjects_(getSheet_('Checklists')).filter(function (t) {
    return t.category === caseRow.category;
  });
  var caseItems = sheetToObjects_(getSheet_('CaseChecklist')).filter(function (c) {
    return c.case_id === caseId;
  });

  var merged = templates.map(function (t) {
    var match = null;
    for (var i = 0; i < caseItems.length; i++) {
      if (caseItems[i].item === t.item) { match = caseItems[i]; break; }
    }
    return {
      group: t.group,
      item: t.item,
      sort: Number(t.sort) || 0,
      link: t.link || '',
      done: match ? truthy_(match.done) : false,
      done_by: match ? match.done_by : '',
      done_at: match ? match.done_at : ''
    };
  });

  merged.sort(function (a, b) {
    var ra = checklistGroupRank_(a.group);
    var rb = checklistGroupRank_(b.group);
    if (ra !== rb) return ra - rb;
    return a.sort - b.sort;
  });

  return { ok: true, checklist: merged };
}

/**
 * action: toggleChecklistItem
 * body: { action:'toggleChecklistItem', token, case_id, item, done }
 * 只有 admin 能操作。done_by 自動用 token 裡記的操作者姓名，不用前端再傳一次。
 */
function handleToggleChecklistItem_(body) {
  var caseId = body.case_id;
  var item = body.item;
  var done = !!body.done;
  var auth = requireAuth_(body.token, 'admin', caseId);

  if (!item) return { ok: false, error: '缺少 item' };

  return withLock_(function () {
    var patch = {
      done: done ? 'TRUE' : 'FALSE',
      done_by: done ? auth.operatorName : '',
      done_at: done ? nowIso_() : ''
    };
    var updated = updateRow_('CaseChecklist', function (r) {
      return r.case_id === caseId && r.item === item;
    }, patch);

    if (!updated) return { ok: false, error: '找不到這個檢核項目（案件建立後範本被改過？）' };

    appendEventLog_(caseId, done ? 'checklist_done' : 'checklist_undone', item, item, auth.operatorName);
    return { ok: true };
  });
}
