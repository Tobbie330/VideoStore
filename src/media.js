'use strict';
// ffmpeg / ffprobe helpers. Every published video and image is rewritten by
// ffmpeg with all metadata (title, comment, GPS/location, device, encoder,
// creation time, chapters, cover art, data/subtitle tracks) removed.
const { spawn } = require('node:child_process');
const config = require('./config');

function run(cmd, args, { timeoutMs = 6 * 60 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => p.kill('SIGKILL'), timeoutMs);
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { if (err.length < 20000) err += d; });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(out);
      else reject(new Error(`${cmd} exited with ${code}: ${err.trim().split('\n').slice(-3).join(' | ')}`));
    });
  });
}

async function probe(file) {
  const out = await run(config.ffprobePath, ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', file], { timeoutMs: 120000 });
  const info = JSON.parse(out);
  const streams = info.streams || [];
  const video = streams.find((s) => s.codec_type === 'video' && !(s.disposition && s.disposition.attached_pic));
  const audio = streams.find((s) => s.codec_type === 'audio');
  return {
    duration: Math.round(Number(info.format && info.format.duration) || Number(video && video.duration) || 0),
    videoCodec: video ? video.codec_name : null,
    audioCodec: audio ? audio.codec_name : null,
    width: video ? video.width : 0,
    height: video ? video.height : 0,
  };
}

const STRIP_ARGS = [
  '-map_metadata', '-1',          // drop global metadata
  '-map_metadata:s:v', '-1',      // drop per-stream metadata
  '-map_metadata:s:a', '-1',
  '-map_chapters', '-1',          // drop chapters
  '-fflags', '+bitexact',         // don't write encoder/version tags
  '-flags:v', '+bitexact',
  '-flags:a', '+bitexact',
];

// Rewrites the video into a clean, web-playable MP4 with no metadata.
// Only the main video track and first audio track are kept (cover art,
// subtitle and data tracks - which can carry GPS/device info - are dropped).
async function stripVideo(input, output, info) {
  const canCopy = info.videoCodec === 'h264' && (!info.audioCodec || ['aac', 'mp3'].includes(info.audioCodec));
  const codecArgs = canCopy
    ? ['-c', 'copy']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k'];
  await run(config.ffmpegPath, [
    '-v', 'error', '-y', '-i', input,
    '-map', '0:V:0', '-map', '0:a:0?', '-sn', '-dn',
    ...STRIP_ARGS, ...codecArgs,
    '-movflags', '+faststart', '-f', 'mp4', output,
  ]);
}

// Re-encodes any image (or a frame of a video) to a metadata-free JPEG.
async function stripImage(input, output, { maxWidth = 1280, seekSeconds = null } = {}) {
  const args = ['-v', 'error', '-y'];
  if (seekSeconds !== null) args.push('-ss', String(seekSeconds));
  args.push('-i', input, '-frames:v', '1', '-vf', `scale='min(${maxWidth},iw)':-2`, ...STRIP_ARGS, '-q:v', '3', '-f', 'image2', '-c:v', 'mjpeg', output);
  await run(config.ffmpegPath, args, { timeoutMs: 120000 });
}

module.exports = { probe, stripVideo, stripImage, run };
