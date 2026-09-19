/* ============================================================
   ATRI-bot · 导航与滚动
   当前项高亮由 HTML 上的 .is-active 静态标记（多页面站，无需 JS）
   ============================================================ */
(function(){
'use strict';

var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var nav = document.getElementById('siteNav');

/* ── 滚动超过 24px 后导航加半透明底 ── */
if (nav){
  var solid = false;
  function onScroll(){
    var want = window.scrollY > 24;
    if (want !== solid){
      solid = want;
      nav.classList.toggle('solid', want);
    }
  }
  window.addEventListener('scroll', onScroll, {passive:true});
  onScroll();
}

/* ── 滚动入场 ── */
var revealables = document.querySelectorAll('[data-reveal]');
if (revealables.length){
  if (window.__atriNavDir){
    /* 跨页转场中：整块内容正从侧面推入，子元素再各自动一次就太吵了。
       直接标成已入场，只留转场这一层动。 */
    Array.prototype.forEach.call(revealables, function(el){ el.classList.add('in'); });
  } else if (reduce || !('IntersectionObserver' in window)){
    /* 减少动效或老浏览器：直接全部显示，不要留下不可见的内容 */
    Array.prototype.forEach.call(revealables, function(el){ el.classList.add('in'); });
  } else {
    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (e.isIntersecting){
          e.target.classList.add('in');
          io.unobserve(e.target);
        }
      });
    }, {threshold:0.16, rootMargin:'0px 0px -8% 0px'});
    Array.prototype.forEach.call(revealables, function(el){ io.observe(el); });
  }
}

})();
