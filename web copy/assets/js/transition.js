/* ============================================================
   ATRI-bot · 跨页平移转场（§8.6）
   必须在 <head> 里同步执行（parser-blocking）：
   ① 入场方向要在首帧之前写到 <html> 上，否则会先看见内容停在原位、
      再"跳"去右边，闪一帧；
   ② pagereveal 的监听器也必须在首帧之前注册好（规范明确要求
      「经典的解析器阻塞脚本」，不能用 module / async / defer），
      否则会错过跨文档 View Transition 的挂载时机。

   两条路径：
   ── A. View Transitions（Chromium 126+ / Safari 18.2+）
      旧页快照滑出的同时新页滑入，是**一次连续运动**。
      全程交给浏览器，JS 只负责把方向写进 <html data-vt>。
   ── B. 回退（不支持的浏览器，如 Firefox）
      仍然是"先滑出去 → 导航 → 再滑进来"两段式。
      §8.6 的 --- 只推内容不推背景 / 导航钉住不动 / 动画完摘标记 /
      bfcache 清理，这四条约束只对 B 有意义。
   ============================================================ */
(function(){
'use strict';

/* 栏目顺序：决定"往哪边推"。改了导航记得同步这里。
   这里用「不带扩展名的 slug」而不是文件名 —— Cloudflare Pages / GitHub Pages 会把
   /works.html **重定向**成 /works，于是落地页的 pathname 就没有 .html 了。
   若按文件名比对，indexOf 会返回 -1，转场在真实托管上**静默失效**，
   而本地用 python -m http.server 测却一切正常（它不做这个重定向）。

   文档的四个子页排在「文档」之后、「作品集」之前：
   这样 首页→文档→作品集 是 forward，而文档页之间互跳也落在同一段里，
   不会出现「点侧边栏换页时整页往反方向推」的错位感。 */
var ORDER = ['index', 'docs', 'docs-start', 'docs-structure', 'docs-arch',
             'works', 'support', 'contact'];
var STORE = 'atri_nav_from';
var root  = document.documentElement;
var LEAVING = 'is-leaving';

function keyOf(p){
  var f = String(p || '').split('/').pop().replace(/\.html?$/i, '');
  return f || 'index';
}
var here = keyOf(location.pathname);

/* ── 读 CSS 里的时长，避免 JS 和 CSS 各写一份数字后悄悄跑偏 ── */
function msOf(name, fallback){
  var raw = getComputedStyle(root).getPropertyValue(name).trim();
  var n = parseFloat(raw);
  if (!isFinite(n)) return fallback;
  return /ms$/.test(raw) ? n : n * 1000;      /* 裸秒数也认 */
}

var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* 跨文档 View Transition 是否可用。
   注意这只是「接口存在」，不等于「真的会跑」——
   本工作区的 VS Code 内置浏览器（Electron 42 / Chrome 148）就是
   PageRevealEvent 存在、但 pageswap / pagereveal 一个都不触发、
   activeViewTransition 也始终为空。所以真正的依据是上一次导航的实测。 */
var VT_OK = typeof PageRevealEvent !== 'undefined';

/* 上一次导航「转场到底跑没跑」的记录：'1' 跑过 / '0' 没跑 / null 还没试过 */
var VTF = 'atri_vt_ok';
var vtKnown = null;
try{ vtKnown = sessionStorage.getItem(VTF); }catch(e){}

/* ============================================================
   一、入场方向
   方向只由「从哪一页到哪一页」决定，与是谁发起的跳转无关 ——
   所以浏览器的后退/前进按钮也能拿到正确方向，不需要额外记账。
   ============================================================ */
var dir = '';
try{
  var from = sessionStorage.getItem(STORE);
  if (from && from !== here){
    var a = ORDER.indexOf(from), b = ORDER.indexOf(here);
    if (a > -1 && b > -1) dir = b > a ? 'forward' : 'back';
    /* 文档页之间改用交叉淡化，不做整页平移 ——
       换的是同一篇文档里的一个小节，横向位移会显得「去了别的栏目」。
       两边都以 'docs' 起头就算文档内部（'docs' / 'docs-start' / …）。 */
    if (from.indexOf('docs') === 0 && here.indexOf('docs') === 0) dir = 'fade';
  }
  /* 只有栏目页才配当「上一页」。404 之类不在 ORDER 里的页面若也写进去，
     下一次导航的 from 就查不到序号，方向算不出来，那一次会白白丢掉动画；
     而且它记下的"来源"本身就是错的。 */
  if (ORDER.indexOf(here) > -1) sessionStorage.setItem(STORE, here);
}catch(e){ /* 隐私模式禁用存储时静默降级：只是没有入场动画，页面照常 */ }

/* ── 路径 A：把方向交给浏览器的跨文档转场 ──────────────────
   方向在这里就能**同步**算出来（上一页存在 sessionStorage 里，
   本页 pathname 也在），所以完全不需要 pagereveal ——
   那个事件在部分 Electron / 内嵌内核里接口存在却根本不触发
   （本工作区的 VS Code 内置浏览器就是这样），依赖它会静默失效。

   两个标记同时写，各管一路：
     data-vt      → 真跨文档转场用的滑动（CSS 变量同理传到伪元素）
     data-nav-in  → 回退路径用的推入
   转场若在跑，CSS 里的 :active-view-transition 会把回退动画关掉，
   所以两者不会同时播。 */
if (dir && !reduce){
  root.setAttribute('data-vt', dir);
  root.setAttribute('data-nav-in', dir);
  window.__atriNavDir = dir;          /* nav.js 读到它就不再自己播一次入场 */

  /* 动画跑完就把标记摘掉，免得它一直压着 [data-reveal] 和 will-change */
  setTimeout(function(){
    root.removeAttribute('data-nav-in');
    root.removeAttribute('data-vt');
  }, msOf('--dur-nav-vt', 520) + 380);
}

/* 本页若是刚被跨文档转场带进来的，activeViewTransition 此刻非空。
   这是唯一能确认「转场真的跑了」的同步信号，记下来给下一页用。 */
try{
  if (dir && VT_OK){
    sessionStorage.setItem(VTF, document.activeViewTransition ? '1' : '0');
  }
}catch(e){}

/* ============================================================
   二、离场（仅回退路径）
   捕获阶段拦站内链接，先把内容推出去，再交给浏览器跳。
   跨文档转场在跑时**必须**原样放行：若在这里先位移，浏览器拍到的旧页
   快照就已经是偏移过的状态，转场会从错误的位置起步。

   问题是「这次会不会真的跑转场」在点击那一刻问不出来 —— 没有同步 API。
   所以用**上一次导航的实测结果**推断，存在 sessionStorage 里：
     '1' = 上次确实跑成了转场 → 这次放行；
     '0' = 上次没跑成       → 这次照常播离场动画；
     空 = 还没试过        → 先乐观放行（宁可第一次少一段离场动画，
           也不能冒着毁掉旧页快照的风险）。一次导航后就能自我纠正。
   ============================================================ */
function internalTarget(a){
  if (!a || !a.getAttribute) return null;
  var t = a.getAttribute('target');
  if (t && t !== '_self') return null;                 /* 新标签页不参与 */
  var href = a.getAttribute('href') || '';
  if (!href || href.charAt(0) === '#') return null;    /* 页内锚点不参与 */
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.slice(0,2) === '//') return null;
  var path = href.split('#')[0].split('?')[0];
  if (!path) return null;
  var key = keyOf(path);
  return ORDER.indexOf(key) > -1 ? key : null;         /* 只对四个栏目页生效 */
}

var leaving = false;

document.addEventListener('click', function(ev){
  if (leaving || reduce || ev.defaultPrevented) return;
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

  var el = ev.target;
  var a  = el && el.closest ? el.closest('a') : null;
  var to = internalTarget(a);
  if (!to) return;

  /* 会跑转场就放行（含「还没试过」的乐观情况），交给浏览器 */
  if (VT_OK && vtKnown !== '0') return;

  /* 文档内部换页：**不播离场，直接跳**。
     两段式回退里「整页淡出 → 跳 → 淡入」会闪一下，那正是要避免的
     翻页感；而整页左推（这里以前算出来的 forward）就更明显了。
     不 preventDefault ⇒ 浏览器正常导航，到达后只让正文自己淡入
     （见 layout.css 的 html[data-nav-in="fade"] .docs__article）。 */
  if (here.indexOf('docs') === 0 && to.indexOf('docs') === 0) return;

  var a0 = ORDER.indexOf(here), b0 = ORDER.indexOf(to);
  var out = b0 > a0 ? 'forward' : 'back';

  ev.preventDefault();
  leaving = true;
  root.setAttribute('data-nav-out', out);
  root.classList.add(LEAVING);
  setTimeout(function(){ location.href = a.href; }, msOf('--dur-nav-out', 240));
}, true);

/* ============================================================
   三、从 bfcache 回来
   页面是在"已经推出去"的状态下被冻结的，复活时必须把标记清干净，
   否则一按后退就是一片空白 —— 内容全在屏幕外面。
   data-vt 一并清掉，免得它让下一次无关的导航也误判方向。
   ============================================================ */
addEventListener('pageshow', function(ev){
  if (!ev.persisted) return;
  leaving = false;
  root.classList.remove(LEAVING);
  root.removeAttribute('data-nav-out');
  root.removeAttribute('data-nav-in');
  root.removeAttribute('data-vt');
});

})();
