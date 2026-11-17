const MIN_BUFFER=5;
const LOW_BUFFER=0.65;
const START_LEAD_MS=650;
const STALL_GRACE_MS=1600;
const WATCH_TIMEOUT_MS=5500;

export function playbackPosition(playback,now=Date.now()) {
  return playback.position+(playback.paused?0:Math.max(0,now-playback.at)/1000);
}

export function setPlayback(room,phase,position,now=Date.now()) {
  room.playback={
    phase,position,paused:phase!=='playing',
    at:now+(phase==='playing'?START_LEAD_MS:0),
    sequence:(room.playback?.sequence||0)+1
  };
}

export function watchReady(playback,watch,now=Date.now()) {
  if(watch?.sequence!==playback.sequence||now-watch.at>WATCH_TIMEOUT_MS||watch.waiting||watch.blocked||!watch.paused)return false;
  if(Math.abs(watch.position-playback.position)>0.4)return false;
  const remaining=Math.max(0,watch.duration-playback.position);
  return watch.position+watch.bufferAhead-playback.position>=Math.min(MIN_BUFFER,remaining)-0.2;
}

export function updateGroupPlayback(room,now=Date.now()) {
  const playback=room.playback;
  const members=[...room.members.values()].filter(member=>member.present||member.stream);
  if(playback.phase==='buffering'&&members.length&&room.members.get(room.host)?.stream) {
    const ready=members.every(({stream,watch})=>stream&&watchReady(playback,watch,now));
    if(ready){setPlayback(room,'playing',playback.position,now);return true;}
  }
  if(playback.phase==='playing') {
    const stalled=members.filter(({stream,watch})=>
      !stream||now>=playback.at+STALL_GRACE_MS&&(
        !watch||now-watch.at>WATCH_TIMEOUT_MS||
        watch.sequence===playback.sequence&&(watch.blocked||watch.waiting||
          (watch.paused||watch.bufferAhead<LOW_BUFFER)&&watch.duration-watch.position>1)
      )
    );
    if(stalled.length) {
      const position=playbackPosition(playback,now);
      const positions=stalled.flatMap(({watch})=>watch?.sequence===playback.sequence?[watch.position]:[]);
      const resumedAt=Math.max(playback.position,Math.min(position,...positions));
      setPlayback(room,'buffering',resumedAt,now);
      return true;
    }
  }
  return false;
}
