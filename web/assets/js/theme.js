(function(){
'use strict';

var root = document.documentElement;
var STORE = 'atri_theme';
var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var VEIL_IN = 190;

function stored(){
  try {
    var v = localStorage.getItem(STORE);
    return (v === 'day' || v === 'night') ? v : null;
  } catch(e){ return null; }
}

function byClock(){
  var d = new Date();
  var h = d.getHours() + d.getMinutes() / 60;
  return (h >= 6.5 && h < 18) ? 'day' : 'night';
}

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

var initial = byParam() || stored() || byClock();
paint(initial);
root.setAttribute('data-veil', initial);

function switchTo(next){
  if (next === current()) return;

  if (reduce){
    root.setAttribute('data-veil', next);
    paint(next);
    return;
  }

  root.classList.add('is-veiling');

  setTimeout(function(){
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

var toggleBtn = null;

function syncToggle(){
  if (!toggleBtn) return;
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

window.__atriTheme = {
  current: current,
  set: switchTo,
  toggle: toggle,
  clear: function(){ try { localStorage.removeItem(STORE); } catch(e){} },
  resolve: function(){ return byParam() || stored() || byClock(); }
};

})();
