(function(){
'use strict';

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

function msOf(name, fallback){
  var raw = getComputedStyle(root).getPropertyValue(name).trim();
  var n = parseFloat(raw);
  if (!isFinite(n)) return fallback;
  return /ms$/.test(raw) ? n : n * 1000;
}

var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

var VT_OK = typeof PageRevealEvent !== 'undefined';

var VTF = 'atri_vt_ok';
var vtKnown = null;
try{ vtKnown = sessionStorage.getItem(VTF); }catch(e){}

var dir = '';
try{
  var from = sessionStorage.getItem(STORE);
  if (from && from !== here){
    var a = ORDER.indexOf(from), b = ORDER.indexOf(here);
    if (a > -1 && b > -1) dir = b > a ? 'forward' : 'back';
    if (from.indexOf('docs') === 0 && here.indexOf('docs') === 0) dir = 'fade';
  }
  if (ORDER.indexOf(here) > -1) sessionStorage.setItem(STORE, here);
}catch(e){  }

if (dir && !reduce){
  root.setAttribute('data-vt', dir);
  root.setAttribute('data-nav-in', dir);
  window.__atriNavDir = dir;

  setTimeout(function(){
    root.removeAttribute('data-nav-in');
    root.removeAttribute('data-vt');
  }, msOf('--dur-nav-vt', 520) + 380);
}

try{
  if (dir && VT_OK){
    sessionStorage.setItem(VTF, document.activeViewTransition ? '1' : '0');
  }
}catch(e){}

function internalTarget(a){
  if (!a || !a.getAttribute) return null;
  var t = a.getAttribute('target');
  if (t && t !== '_self') return null;
  var href = a.getAttribute('href') || '';
  if (!href || href.charAt(0) === '#') return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(href) || href.slice(0,2) === '//') return null;
  var path = href.split('#')[0].split('?')[0];
  if (!path) return null;
  var key = keyOf(path);
  return ORDER.indexOf(key) > -1 ? key : null;
}

var leaving = false;

document.addEventListener('click', function(ev){
  if (leaving || reduce || ev.defaultPrevented) return;
  if (ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;

  var el = ev.target;
  var a  = el && el.closest ? el.closest('a') : null;
  var to = internalTarget(a);
  if (!to) return;

  if (VT_OK && vtKnown !== '0') return;

  if (here.indexOf('docs') === 0 && to.indexOf('docs') === 0) return;

  var a0 = ORDER.indexOf(here), b0 = ORDER.indexOf(to);
  var out = b0 > a0 ? 'forward' : 'back';

  ev.preventDefault();
  leaving = true;
  root.setAttribute('data-nav-out', out);
  root.classList.add(LEAVING);
  setTimeout(function(){ location.href = a.href; }, msOf('--dur-nav-out', 240));
}, true);

addEventListener('pageshow', function(ev){
  if (!ev.persisted) return;
  leaving = false;
  root.classList.remove(LEAVING);
  root.removeAttribute('data-nav-out');
  root.removeAttribute('data-nav-in');
  root.removeAttribute('data-vt');
});

})();
