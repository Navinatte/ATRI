/* ============================================================
   ATRI-bot · 昼夜极性
   对应《视觉设计规范.md》§3.9

   本期只用「白天 / 夜晚」两套静态色值，不接时间轴。
   ⚑ 这个文件必须以「同步脚本」形式放在 <head> 里（CSS 之后），
     好让 data-polarity 在首帧之前就写好 —— 否则会先闪一下夜晚。
   ============================================================ */
(function(){
'use strict';

var root = document.documentElement;
var STORE = 'atri_theme';
var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/* 起雾 180ms（见 base.css 的 .veil），这里等 190ms 确保已经盖满。
   早一步换天就会露出一帧的糊字。 */
var VEIL_IN = 190;

/* ---------- 决定极性 ---------- */

function stored(){
  try {
    var v = localStorage.getItem(STORE);
    return (v === 'day' || v === 'night') ? v : null;
  } catch(e){ return null; }
}

/* 默认按本地时间二选一。这两个钟点对应 §3.8.4 解出的极性翻转时刻，
   不要随意改 —— 它们保证页面不会落在「白字深字都不达标」的死区里。 */
function byClock(){
  var d = new Date();
  var h = d.getHours() + d.getMinutes() / 60;
  return (h >= 6.5 && h < 18) ? 'day' : 'night';
}

/* ?theme=day / ?theme=night —— 评审与截图用，不写入 localStorage */
function byParam(){
  try {
    var m = /[?&]theme=(day|night)/.exec(location.search);
    return m ? m[1] : null;
  } catch(e){ return null; }
}

function current(){ return root.getAttribute('data-polarity') || 'night'; }

function paint(next){
  root.setAttribute('data-polarity', next);
  syncToggle();
}

function persist(next){
  try { localStorage.setItem(STORE, next); } catch(e){}
}

/* ⚑ 首帧前写入 */
var initial = byParam() || stored() || byClock();
paint(initial);
root.setAttribute('data-veil', initial);

/* ---------- 切换（§3.9.2 的「过渡盖布」）---------- */

function switchTo(next){
  if (next === current()) return;

  /* ⚑ 起雾用的是「当前」主题的颜色，不是目标色。
     因为盖布是渐渐变不透明的：若一上来就用目标色，中途必然经过一个中间调，
     而此刻文字还是旧极性的颜色（白字压在中灰上）—— 正是 §3.8.4 要避免的事。
     用当前色则是「自己的底色慢慢盖住自己」，文字全程有底可踩。 */
  if (reduce){
    root.setAttribute('data-veil', next);
    paint(next);
    return;
  }

  root.classList.add('is-veiling');

  setTimeout(function(){
    /* 此刻盖布已经完全不透明，底下什么都看不见 ——
       极性组与盖布颜色在这里一次换掉，不会闪。 */
    root.setAttribute('data-veil', next);
    paint(next);
    root.classList.remove('is-veiling');
  }, VEIL_IN);
}

function toggle(){
  var next = current() === 'day' ? 'night' : 'day';
  persist(next);
  switchTo(next);
}

/* ---------- 绑定 ---------- */

var toggleBtn = null;

function syncToggle(){
  if (!toggleBtn) return;
  /* 显示的是「点了会去哪个主题」的图标，所以标签描述的是目标主题 */
  var next = current() === 'day' ? 'night' : 'day';
  toggleBtn.setAttribute('aria-label', next === 'day' ? '切换为白天主题' : '切换为夜晚主题');
  toggleBtn.setAttribute('title', next === 'day' ? '切换到白天' : '切换到夜晚');
}

function boot(){
  toggleBtn = document.getElementById('themeToggle');
  if (toggleBtn){
    toggleBtn.addEventListener('click', toggle);
    syncToggle();
  }

  /* 用户没有手动选过时，页面被搁置到另一个时段再回来看，
     应当跟着时间走 —— 只在可见性变化时检查，不做轮询。 */
  if (!stored()){
    document.addEventListener('visibilitychange', function(){
      if (document.visibilityState !== 'visible') return;
      if (stored()) return;
      var want = byClock();
      if (want !== current()) switchTo(want);
    });
  }
}

if (document.readyState === 'loading'){
  document.addEventListener('DOMContentLoaded', boot);
} else {
  boot();
}

/* 调试出口 */
window.__atriTheme = {
  current: current,
  set: switchTo,
  toggle: toggle,
  clear: function(){ try { localStorage.removeItem(STORE); } catch(e){} },
  resolve: function(){ return byParam() || stored() || byClock(); }
};

})();
