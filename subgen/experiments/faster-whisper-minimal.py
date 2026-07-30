from faster_whisper import WhisperModel

m = WhisperModel("large-v3")  # hız için "medium" veya "large-v3-turbo" da olur

segments, info = m.transcribe(
    "../out/interview.wav",
    vad_filter=True,                 # sessizlik/nefesleri keser -> tekrar azalır
    beam_size=8,                     # daha istikrarlı decoding
    condition_on_previous_text=False # döngü/tekrarları azaltabilir
)

with open("../faster-whisper.txt","w") as f:
    for s in segments:
        f.write(f"[{s.start:.2f}-{s.end:.2f}] {s.text}\n")

