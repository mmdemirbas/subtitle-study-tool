#!/usr/bin/env bash

file="../subtitles/Battlestar.Galactica.Miniseries.S00E02.2003.1080p.BluRay-EN.srt"

source .venv/bin/activate # activate virtual environment
source .env               # load OPENAI_API_KEY

# Ask before starting to avoid accidental API costs
read -p "This will invoke paid OpenAI APIs to translate the file $file. Do you want to continue? (y/N) " choice
if [[ "$choice" != "y" ]]; then
  echo "Aborting."
  exit 1
fi

python srt_translate.py "$file" \
  --provider openai \
  --openai-model gpt-5-nano \
  --tgt tr \
  --api-key "$OPENAI_API_KEY" \
  --batch 20
