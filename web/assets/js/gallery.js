(function(){
'use strict';

var gallery = document.getElementById('gallery');
var track   = document.getElementById('galleryTrack');
if (!gallery || !track) return;

var items = Array.prototype.slice.call(track.querySelectorAll('.gallery__item'));
if (!items.length) return;

var prevBtn = document.getElementById('galleryPrev');
var nextBtn = document.getElementById('galleryNext');
var nowEl   = document.getElementById('galleryNow');

var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var LAST = items.length - 1;

function pad2(n){ return (n < 9 ? '0' : '') + (n + 1); }

function currentIndex(){
  var tr = track.getBoundingClientRect();
  var mid = tr.left + tr.width / 2;
  var best = 0, bestD = Infinity;
  for (var i = 0; i < items.length; i++){
    var r = items[i].getBoundingClientRect();
    var d = Math.abs(r.left + r.width / 2 - mid);
    if (d < bestD){ bestD = d; best = i; }
  }
  return best;
}

function goTo(i){
  i = Math.max(0, Math.min(LAST, i));
  var tr = track.getBoundingClientRect();
  var r  = items[i].getBoundingClientRect();
  var origin = tr.left + track.clientLeft;
  var want   = (track.clientWidth - r.width) / 2;
  var left   = track.scrollLeft + (r.left - origin) - want;
  var instant = reduce;
  track.scrollTo({ left: Math.max(0, left), behavior: instant ? 'auto' : 'smooth' });
  if (instant) sync();
}

function sync(){
  var i = currentIndex();
  for (var k = 0; k < items.length; k++){
    items[k].classList.toggle('is-current', k === i);
  }
  if (nowEl) nowEl.textContent = pad2(i);
  if (prevBtn) prevBtn.disabled = (i <= 0);
  if (nextBtn) nextBtn.disabled = (i >= LAST);
}

var ticking = false;
function onScroll(){
  if (ticking) return;
  ticking = true;
  requestAnimationFrame(function(){
    ticking = false;
    sync();
  });
}

track.addEventListener('scroll', onScroll, {passive:true});
if ('onscrollend' in track) track.addEventListener('scrollend', sync);
window.addEventListener('resize', onScroll);

if (prevBtn) prevBtn.addEventListener('click', function(){ goTo(currentIndex() - 1); });
if (nextBtn) nextBtn.addEventListener('click', function(){ goTo(currentIndex() + 1); });

track.addEventListener('keydown', function(e){
  var k = e.key;
  if (k === 'ArrowRight'){ e.preventDefault(); goTo(currentIndex() + 1); }
  else if (k === 'ArrowLeft'){ e.preventDefault(); goTo(currentIndex() - 1); }
  else if (k === 'Home'){ e.preventDefault(); goTo(0); }
  else if (k === 'End'){ e.preventDefault(); goTo(LAST); }
});

gallery.classList.add('is-live');
items[0].classList.add('is-current');
sync();
})();
