const clock=document.querySelector('#clock');
let paused=false;
function format(seconds){return `${String(Math.floor(seconds/60)).padStart(2,'0')}:${String(seconds%60).padStart(2,'0')}`}
document.querySelector('#pause').onclick=()=>window.studio.togglePause();
document.querySelector('#stop').onclick=()=>window.studio.stop();
document.querySelector('#studio').onclick=()=>window.studio.showStudio();
window.studio.onMiniControl('control:tick',seconds=>clock.textContent=format(seconds));
window.studio.onMiniControl('control:paused',value=>{paused=value;const button=document.querySelector('#pause');button.innerHTML=paused?'▶ <small>Resume</small>':'Ⅱ <small>Pause</small>';document.querySelector('.recording-state>span:nth-child(2)').textContent=paused?'PAUSED':'RECORDING';document.querySelector('.pulse').style.animationPlayState=paused?'paused':'running'});
