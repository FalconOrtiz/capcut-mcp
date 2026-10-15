#!/bin/sh
# Generate free demo assets with ffmpeg (no third-party media, no licence questions):
#   clip.mp4  - 10 s, 1080x1920, 30 fps, H.264 + AAC test pattern with a soft tone
#   music.m4a - 20 s synthesized chord pad (AAC), made here, so it is royalty-free
# The SRT (demo/demo.srt) is in the repo. Usage: sh scripts/make-demo-assets.sh [out_dir]
set -eu
out="${1:-demo}"
mkdir -p "$out"
command -v ffmpeg >/dev/null 2>&1 || { echo "ffmpeg not found" >&2; exit 1; }
ffmpeg -hide_banner -loglevel error -y \
  -f lavfi -i "testsrc2=size=1080x1920:rate=30:duration=10" \
  -f lavfi -i "sine=frequency=220:sample_rate=48000:duration=10" \
  -filter:a "volume=0.05" -c:v libx264 -pix_fmt yuv420p -profile:v high -crf 28 -preset veryfast \
  -c:a aac -b:a 96k -movflags +faststart -shortest "$out/clip.mp4"
# Four-chord pad (C - G - Am - F), 5 s each, with a gentle tremolo.
ffmpeg -hide_banner -loglevel error -y -f lavfi -i "aevalsrc='\
0.12*(sin(2*PI*if(lt(mod(t,20),5),261.63,if(lt(mod(t,20),10),196.00,if(lt(mod(t,20),15),220.00,174.61)))*t)\
+sin(2*PI*if(lt(mod(t,20),5),329.63,if(lt(mod(t,20),10),246.94,if(lt(mod(t,20),15),261.63,220.00)))*t)\
+sin(2*PI*if(lt(mod(t,20),5),392.00,if(lt(mod(t,20),10),293.66,if(lt(mod(t,20),15),329.63,261.63)))*t))\
*(0.8+0.2*sin(2*PI*0.5*t))|0.12*(sin(2*PI*if(lt(mod(t,20),5),261.63,if(lt(mod(t,20),10),196.00,if(lt(mod(t,20),15),220.00,174.61)))*t)\
+sin(2*PI*if(lt(mod(t,20),5),329.63,if(lt(mod(t,20),10),246.94,if(lt(mod(t,20),15),261.63,220.00)))*t)\
+sin(2*PI*if(lt(mod(t,20),5),392.00,if(lt(mod(t,20),10),293.66,if(lt(mod(t,20),15),329.63,261.63)))*t))\
*(0.8+0.2*cos(2*PI*0.5*t)):s=48000:d=20'" \
  -af "afade=t=in:d=1,afade=t=out:st=19:d=1" -c:a aac -b:a 128k -movflags +faststart "$out/music.m4a"
ls -l "$out/clip.mp4" "$out/music.m4a"
