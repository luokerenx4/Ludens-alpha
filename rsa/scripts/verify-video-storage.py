#!/usr/bin/env python3
"""Offline dual-stream recording soak. Writes only to a fresh output directory."""

import argparse
import base64
from datetime import datetime, timezone
from io import BytesIO
import json
import os
from pathlib import Path
import statistics
import subprocess
import time

from PIL import Image, ImageChops, ImageDraw, ImageStat
from rsa_tools._observation_history import ObservationHistory


def picture(index, channel):
    image = Image.new("RGB", (320, 240), (30, 50 + channel * 30, 80))
    draw = ImageDraw.Draw(image)
    # Moving edges plus small text exercise interframe compression and legibility.
    x = (index * 3 + channel * 13) % 280
    draw.rectangle((x, 80, x + 35, 120), fill=(220, 90, 30))
    for line in range(6):
        draw.text((5, 5 + line * 12), f"Frame {index:05d} / screen {channel} / text {line}", fill=(235, 240, 250))
    output = BytesIO()
    image.save(output, format="PNG")
    return image, output.getvalue()


def rss_bytes():
    return int(subprocess.check_output(["ps", "-o", "rss=", "-p", str(os.getpid())], text=True).strip()) * 1024


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--records", type=int, default=2400)
    parser.add_argument("--rate", type=float, default=30)
    arguments = parser.parse_args()
    arguments.output.mkdir(parents=True, exist_ok=False)
    os.environ["RSA_PERCEPTION_HOT_BYTES"] = "1048576"
    os.environ["RSA_PERCEPTION_HOT_SECONDS"] = "1"
    history = ObservationHistory(arguments.output)
    saved, points, png_bytes = [], [], 0
    started = time.monotonic()
    sampling = {"clock": "soak", "startedAtMs": 0, "finishedAtMs": 1}
    try:
        for index in range(arguments.records):
            media = []
            for channel in range(2):
                _, raw = picture(index, channel)
                png_bytes += len(raw)
                media.append({"mediaType": "image/png", "data": base64.b64encode(raw).decode()})
            at = datetime.fromtimestamp(1_793_102_400 + index / arguments.rate, timezone.utc).isoformat()
            record = history.append({"media": media}, "soak", sampling, at)
            if index % 600 == 0 or index == arguments.records - 1:
                saved.append((index, record["id"]))
            if index % 100 == 0 or index == arguments.records - 1:
                points.append({"record": index, "rssBytes": rss_bytes(), "hotBytes": history.hot_bytes,
                               **history._video.metrics()})
            delay = (index + 1) / arguments.rate - (time.monotonic() - started)
            if delay > 0:
                time.sleep(delay)
    finally:
        history.close()
    encoded = sum(path.stat().st_size for path in arguments.output.rglob("*.mp4"))
    frames, maximum_error = 0, 0
    cold = ObservationHistory(arguments.output)
    try:
        for index, record_id in saved:
            actual = cold.observe({"id": record_id})["records"][0]
            for channel, media in enumerate(actual["media"]):
                image = Image.open(BytesIO(base64.b64decode(media["data"]))).convert("RGB")
                original, _ = picture(index, channel)
                maximum_error = max(maximum_error, statistics.mean(ImageStat.Stat(ImageChops.difference(image, original)).mean))
                frames += 1
    finally:
        cold.close()
    middle = points[len(points) // 3: 2 * len(points) // 3]
    tail = points[2 * len(points) // 3:]
    report = {"records": arguments.records, "frames": arguments.records * 2,
              "elapsedSeconds": time.monotonic() - started, "rate": arguments.rate,
              "metrics": history._video.metrics(), "pngBytesIfArchived": png_bytes, "videoBytes": encoded,
              "ratio": png_bytes / encoded, "coldDecodedFrames": frames, "maximumMeanPixelError": maximum_error,
              "rssPeakBytes": max(point["rssBytes"] for point in points),
              "rssMiddleMeanBytes": statistics.mean(point["rssBytes"] for point in middle),
              "rssTailMeanBytes": statistics.mean(point["rssBytes"] for point in tail),
              "hotPeakBytes": max(point["hotBytes"] for point in points), "samples": points,
              "imageFiles": len(list(arguments.output.rglob("*.png"))) + len(list(arguments.output.rglob("*.bin")))}
    (arguments.output / "verification.json").write_text(json.dumps(report, indent=2) + "\n")
    print(json.dumps({key: value for key, value in report.items() if key != "samples"}, indent=2))


if __name__ == "__main__":
    main()
