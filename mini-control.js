const clock = document.querySelector('#clock');
const pauseButton = document.querySelector('#pause');
const stateLabel = document.querySelector('#state-label');
const pulse = document.querySelector('.pulse');
const badge = document.querySelector('#agent-badge');

const format = seconds => `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
function showPaused(paused) {
  pauseButton.replaceChildren(paused ? '▶ ' : 'Ⅱ ', Object.assign(document.createElement('small'), { textContent: paused ? 'Resume' : 'Pause' }));
  pauseButton.title = paused ? 'Resume recording' : 'Pause recording';
  stateLabel.textContent = paused ? 'PAUSED' : 'RECORDING';
  pulse.style.animationPlayState = paused ? 'paused' : 'running';
}

pauseButton.onclick = () => window.controls.togglePause();
document.querySelector('#stop').onclick = () => window.controls.stop();
document.querySelector('#studio').onclick = () => window.controls.showStudio();
window.controls.on('control:agent', value => { badge.hidden = !value; });
window.controls.on('control:tick', seconds => { clock.textContent = format(seconds); });
window.controls.on('control:paused', showPaused);
window.controls.getState().then(state => {
  badge.hidden = !state.byAgent;
  clock.textContent = format(state.seconds);
  showPaused(state.paused);
});
