Three HLS segments made the way the worker makes them (worker/src/vocaleaf_worker/hls.py), from a 5 s sine:

    ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=24000:duration=5" -c:a aac -b:a 48k -ac 1 \
      -f hls -hls_time 2 -hls_list_size 0 -hls_playlist_type event -hls_segment_type mpegts \
      -hls_segment_filename "seg-%05d.ts" index.m3u8

The playlist said 2.005333 s, 2.005333 s and 1.032 s. Renamed to `.mpegts` so TypeScript does not read them.
