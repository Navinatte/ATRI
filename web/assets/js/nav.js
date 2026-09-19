(function(){
'use strict';

var reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
var nav = document.getElementById('siteNav');

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

var revealables = document.querySelectorAll('[data-reveal]');
if (revealables.length){
  if (window.__atriNavDir){
    Array.prototype.forEach.call(revealables, function(el){ el.classList.add('in'); });
  } else if (reduce || !('IntersectionObserver' in window)){
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
