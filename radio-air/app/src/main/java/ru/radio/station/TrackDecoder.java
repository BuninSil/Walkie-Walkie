package ru.radio.station;

import android.content.Context;
import android.media.AudioFormat;
import android.media.MediaCodec;
import android.media.MediaExtractor;
import android.media.MediaFormat;
import android.net.Uri;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;

/*
 * Трек → кадры эфира: декодирует любой формат, который умеет телефон (MP3, AAC/M4A, FLAC,
 * OGG/Opus, WAV…), сводит в моно, переводит в 16 кГц и режет на кадры по 640 сэмплов (40 мс).
 */
final class TrackDecoder {

    interface Out {
        // Кадр готов. false — прекратить (эфир закончили или переключили трек)
        boolean frame(float[] samples) throws InterruptedException;
    }

    private float[] frame = new float[AirPacket.CHUNK];
    private int filled = 0;
    long durationUs = 0;
    long producedSamples = 0; // на 16 кГц — сколько трека уже ушло

    // true — трек доигран до конца, false — остановили
    boolean play(Context context, Uri uri, Out out) throws IOException, InterruptedException {
        MediaExtractor ex = new MediaExtractor();
        MediaCodec codec = null;
        try {
            ex.setDataSource(context, uri, null);
            int track = -1;
            MediaFormat format = null;
            for (int i = 0; i < ex.getTrackCount(); i++) {
                MediaFormat f = ex.getTrackFormat(i);
                String mime = f.getString(MediaFormat.KEY_MIME);
                if (mime != null && mime.startsWith("audio/")) {
                    track = i;
                    format = f;
                    break;
                }
            }
            if (track < 0) throw new IOException("в файле нет звука");
            ex.selectTrack(track);
            durationUs = format.containsKey(MediaFormat.KEY_DURATION) ? format.getLong(MediaFormat.KEY_DURATION) : 0;

            codec = MediaCodec.createDecoderByType(format.getString(MediaFormat.KEY_MIME));
            codec.configure(format, null, null, 0);
            codec.start();

            int rate = format.getInteger(MediaFormat.KEY_SAMPLE_RATE);
            int channels = format.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
            int encoding = AudioFormat.ENCODING_PCM_16BIT;
            Resampler rs = new Resampler(rate);
            float[] mono = new float[0];
            MediaCodec.BufferInfo info = new MediaCodec.BufferInfo();
            boolean inputDone = false;
            boolean[] stop = { false };
            Resampler.Sink sink = (s) -> {
                if (stop[0]) return;
                frame[filled++] = s;
                if (filled == frame.length) {
                    producedSamples += filled;
                    filled = 0;
                    try {
                        if (!out.frame(frame)) stop[0] = true;
                    } catch (InterruptedException e) {
                        stop[0] = true;
                        Thread.currentThread().interrupt();
                    }
                    frame = new float[AirPacket.CHUNK];
                }
            };

            while (!stop[0]) {
                if (Thread.interrupted()) throw new InterruptedException();
                if (!inputDone) {
                    int in = codec.dequeueInputBuffer(10000);
                    if (in >= 0) {
                        ByteBuffer buf = codec.getInputBuffer(in);
                        int n = ex.readSampleData(buf, 0);
                        if (n < 0) {
                            codec.queueInputBuffer(in, 0, 0, 0, MediaCodec.BUFFER_FLAG_END_OF_STREAM);
                            inputDone = true;
                        } else {
                            codec.queueInputBuffer(in, 0, n, ex.getSampleTime(), 0);
                            ex.advance();
                        }
                    }
                }
                int outIndex = codec.dequeueOutputBuffer(info, 10000);
                if (outIndex == MediaCodec.INFO_OUTPUT_FORMAT_CHANGED) {
                    MediaFormat of = codec.getOutputFormat();
                    rate = of.getInteger(MediaFormat.KEY_SAMPLE_RATE);
                    channels = of.getInteger(MediaFormat.KEY_CHANNEL_COUNT);
                    encoding = of.containsKey(MediaFormat.KEY_PCM_ENCODING)
                        ? of.getInteger(MediaFormat.KEY_PCM_ENCODING) : AudioFormat.ENCODING_PCM_16BIT;
                    rs = new Resampler(rate);
                } else if (outIndex >= 0) {
                    ByteBuffer ob = codec.getOutputBuffer(outIndex);
                    if (ob != null && info.size > 0) {
                        ob.position(info.offset);
                        ob.limit(info.offset + info.size);
                        ob.order(ByteOrder.nativeOrder());
                        int frames = encoding == AudioFormat.ENCODING_PCM_FLOAT
                            ? info.size / 4 / channels : info.size / 2 / channels;
                        if (mono.length < frames) mono = new float[frames];
                        for (int i = 0; i < frames; i++) {
                            float sum = 0;
                            for (int c = 0; c < channels; c++) {
                                sum += encoding == AudioFormat.ENCODING_PCM_FLOAT ? ob.getFloat() : ob.getShort() / 32768f;
                            }
                            mono[i] = sum / channels;
                        }
                        rs.process(mono, frames, sink);
                    }
                    codec.releaseOutputBuffer(outIndex, false);
                    if ((info.flags & MediaCodec.BUFFER_FLAG_END_OF_STREAM) != 0) return true;
                }
            }
            if (Thread.currentThread().isInterrupted()) throw new InterruptedException();
            return false;
        } finally {
            if (codec != null) {
                try {
                    codec.stop();
                } catch (RuntimeException ignored) {
                    // кодек уже в ошибке — просто освобождаем
                }
                codec.release();
            }
            ex.release();
        }
    }
}
