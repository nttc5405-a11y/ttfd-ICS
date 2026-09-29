/**
 * 首頁公開資料（跑馬燈）。不需要 token —— 首頁還沒登入任何案件，這是公開公告。
 * 對應 doPost 的 action：getHome。
 */

/**
 * action: getHome
 * 回傳全域跑馬燈開關（Settings, case_id 空白, key='marquee_enabled'，預設開啟）
 * 與啟用中的跑馬燈訊息（Marquee, case_id 空白, enabled=TRUE，依 sort 排序）。
 */
function handleGetHome_() {
  var marqueeEnabled = getSettingBool_('', 'marquee_enabled', true);
  var items = [];

  if (marqueeEnabled) {
    items = sheetToObjects_(getSheet_('Marquee'))
      .filter(function (m) { return m.case_id === '' && truthy_(m.enabled); })
      .sort(function (a, b) { return (Number(a.sort) || 0) - (Number(b.sort) || 0); })
      .map(function (m) { return { content: m.content }; });
  }

  return {
    ok: true,
    marquee_enabled: marqueeEnabled,
    marquee: items
  };
}
