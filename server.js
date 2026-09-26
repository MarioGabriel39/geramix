import express from "express";
import multer from "multer";
import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import os from "os";
import crypto from "crypto";
import { spawn } from "child_process";
import { Readable } from "stream";
import archiver from "archiver";
import ffmpegPath from "ffmpeg-static";
import { waitUntil } from "@vercel/functions";

const app = express();

app.use(express.json({ limit: "1mb" }));

const PORT = process.env.PORT || 3000;
const ROOT = process.cwd();
const PUBLIC = path.join(ROOT, "public");

const BASE = path.join(os.tmpdir(), "geramix");
const UPLOADS = path.join(BASE, "uploads");
const JOBS = path.join(BASE, "jobs");

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

const SUPABASE_DOWNLOAD_BUCKET = "geramix-downloads";

const MAX_COMBINATIONS = 150;
const MAX_HOOKS = 5;
const MAX_BODIES = 5;
const MAX_CTAS = 6;

const MAX_FILE_SIZE = 200 * 1024 * 1024;

/*
 * IMPORTANTE:
 * Cada execução gera somente uma pequena quantidade
 * de vídeos. Depois chama a próxima execução.
 */
const PROCESS_CHUNK_SIZE = 5;

const FFMPEG_TIMEOUT = 10 * 60 * 1000;
const STORAGE_UPLOAD_TIMEOUT = 15 * 60 * 1000;
const STORAGE_DOWNLOAD_TIMEOUT = 15 * 60 * 1000;
const DATABASE_TIMEOUT = 60 * 1000;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  throw new Error(
    "SUPABASE_URL e SUPABASE_ANON_KEY precisam estar configuradas."
  );
}

await Promise.all([
  fsp.mkdir(UPLOADS, { recursive: true }),
  fsp.mkdir(JOBS, { recursive: true })
]);

app.use(express.static(PUBLIC));

/* =========================================================
   CONFIG
========================================================= */

app.get("/api/config", (_, res) => {
  res.setHeader("Cache-Control", "no-store");

  res.json({
    supabaseUrl: SUPABASE_URL,
    supabaseAnonKey: SUPABASE_ANON_KEY
  });
});

/* =========================================================
   HEALTH
========================================================= */

app.get("/health", (_, res) => {
  res.json({
    ok: true,
    service: "geramix",
    ffmpeg: Boolean(ffmpegPath)
  });
});

/* =========================================================
   MULTER
========================================================= */

const upload = multer({
  dest: UPLOADS,

  limits: {
    files: 30,
    fileSize: MAX_FILE_SIZE
  }
});

/* =========================================================
   MEMÓRIA
========================================================= */

const jobs = new Map();

/* =========================================================
   UTILITÁRIOS
========================================================= */

function safeName(name) {
  return String(name || "video.mp4")
    .replace(/[^a-zA-Z0-9._-]/g, "_")
    .slice(-100);
}

function encodedStoragePath(storagePath) {
  return String(storagePath)
    .split("/")
    .map(encodeURIComponent)
    .join("/");
}

function getPublicOrigin(req) {
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }

  const host = req.get("host");

  return `${req.protocol}://${host}`;
}

function workPath(userId, jobId, name) {
  return `${userId}/work/${jobId}/${name}`;
}

/* =========================================================
   FETCH COM TEMPO LIMITE
========================================================= */

async function fetchWithTimeout(
  url,
  options = {},
  timeoutMs = 0
) {
  if (!timeoutMs || timeoutMs <= 0) {
    return fetch(url, options);
  }

  const controller = new AbortController();

  const timer = setTimeout(() => {
    controller.abort();
  }, timeoutMs);

  try {
    return await fetch(url, {
      ...options,
      signal: controller.signal
    });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(
        `Tempo limite atingido após ${Math.round(
          timeoutMs / 60000
        )} minuto(s).`
      );
    }

    throw error;
  } finally {
    clearTimeout(timer);
  }
}

/* =========================================================
   AUTENTICAÇÃO
========================================================= */

async function requireAuth(req, res, next) {
  try {
    const authorization = String(
      req.headers.authorization || ""
    ).trim();

    let token =
      authorization
        .toLowerCase()
        .startsWith("bearer ")
        ? authorization.slice(7).trim()
        : "";

    if (!token) {
      token = String(req.query.token || "").trim();
    }

    if (!token || token.startsWith("sb_")) {
      return res.status(401).json({
        error: "Sessão inválida ou não enviada."
      });
    }

    const response = await fetchWithTimeout(
      `${SUPABASE_URL}/auth/v1/user`,
      {
        headers: {
          Authorization: `Bearer ${token}`,
          apikey: SUPABASE_ANON_KEY
        }
      },
      DATABASE_TIMEOUT
    );

    if (!response.ok) {
      return res.status(401).json({
        error: "Sessão inválida ou expirada."
      });
    }

    const user = await response.json();

    if (!user?.id) {
      return res.status(401).json({
        error: "Sessão inválida ou expirada."
      });
    }

    req.user = user;
    req.accessToken = token;

    next();
  } catch (error) {
    console.error("GeraMix auth:", error);

    return res.status(401).json({
      error: "Não foi possível validar sua sessão."
    });
  }
}

/* =========================================================
   SUPABASE REST
========================================================= */

async function supabaseRequest(
  url,
  options = {},
  accessToken,
  timeoutMs = 0
) {
  const headers = {
    ...(options.headers || {}),
    Authorization: `Bearer ${accessToken}`,
    apikey: SUPABASE_ANON_KEY
  };

  return fetchWithTimeout(
    url,
    {
      ...options,
      headers
    },
    timeoutMs
  );
}

/* =========================================================
   ERRO SUPABASE
========================================================= */

async function getResponseError(response) {
  let text = "";

  try {
    text = await response.text();
  } catch {
    return "";
  }

  if (!text) {
    return "";
  }

  try {
    const data = JSON.parse(text);

    return (
      data?.message ||
      data?.msg ||
      data?.error_description ||
      data?.error ||
      data?.details ||
      data?.hint ||
      text
    );
  } catch {
    return text;
  }
}

/* =========================================================
   RPC
========================================================= */

async function rpc(name, body, accessToken) {
  const response = await supabaseRequest(
    `${SUPABASE_URL}/rest/v1/rpc/${name}`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json"
      },

      body: JSON.stringify(body)
    },
    accessToken,
    DATABASE_TIMEOUT
  );

  const text = await response.text();

  let data = null;

  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
  }

  if (!response.ok) {
    throw new Error(
      data?.message ||
        data?.msg ||
        data?.error_description ||
        data?.error ||
        (typeof data === "string"
          ? data
          : `RPC ${name} falhou com HTTP ${response.status}.`)
    );
  }

  return Array.isArray(data) ? data[0] : data;
}

/* =========================================================
   COTA
========================================================= */

async function reserveVideoQuota(
  userId,
  accessToken,
  amount
) {
  const result = await rpc(
    "reserve_video_quota",
    {
      p_user_id: userId,
      p_amount: amount
    },
    accessToken
  );

  if (!result) {
    throw new Error(
      "O servidor não recebeu a resposta da cota."
    );
  }

  return {
    allowed: Boolean(result.allowed),

    videosUsed: Number(
      result.videos_used || 0
    ),

    monthlyLimit: Number(
      result.monthly_limit || 0
    ),

    message: result.message || ""
  };
}

async function releaseVideoQuota(
  userId,
  accessToken,
  amount
) {
  if (!amount) {
    return;
  }

  try {
    await rpc(
      "release_video_quota",
      {
        p_user_id: userId,
        p_amount: amount
      },
      accessToken
    );
  } catch (error) {
    console.error(
      "GeraMix release quota:",
      error
    );
  }
}

/* =========================================================
   JOBS PERSISTENTES
========================================================= */

async function createPersistentJob(
  job,
  accessToken
) {
  const response = await supabaseRequest(
    `${SUPABASE_URL}/rest/v1/jobs`,
    {
      method: "POST",

      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },

      body: JSON.stringify({
        id: job.id,
        user_id: job.userId,
        status: job.status,
        total: job.total,
        done: job.done,
        current: job.current,
        error: job.error,
        mode: job.mode,
        videos_used: job.videosUsed,
        monthly_limit: job.monthlyLimit
      })
    },
    accessToken,
    DATABASE_TIMEOUT
  );

  if (!response.ok) {
    const detail = await getResponseError(response);

    throw new Error(
      detail ||
        `Não foi possível salvar o processamento (HTTP ${response.status}).`
    );
  }

  const text = await response.text();

  let rows = [];

  if (text) {
    try {
      rows = JSON.parse(text);
    } catch {}
  }

  if (!Array.isArray(rows) || !rows.length) {
    throw new Error(
      "O processamento foi enviado, mas o Supabase não confirmou a criação do job."
    );
  }

  return rows[0];
}

async function updatePersistentJob(
  job,
  accessToken,
  extra = {}
) {
  const body = {
    status: job.status,
    total: job.total,
    done: job.done,
    current: job.current,
    error: job.error,
    mode: job.mode,
    videos_used: job.videosUsed,
    monthly_limit: job.monthlyLimit,
    ...extra
  };

  const response = await supabaseRequest(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeURIComponent(
      job.id
    )}&user_id=eq.${encodeURIComponent(
      job.userId
    )}`,
    {
      method: "PATCH",

      headers: {
        "Content-Type": "application/json",
        Prefer: "return=representation"
      },

      body: JSON.stringify(body)
    },
    accessToken,
    DATABASE_TIMEOUT
  );

  if (!response.ok) {
    const detail = await getResponseError(response);

    throw new Error(
      detail ||
        `Não foi possível atualizar o processamento (HTTP ${response.status}).`
    );
  }

  const text = await response.text();

  let rows = [];

  if (text) {
    try {
      rows = JSON.parse(text);
    } catch {}
  }

  return rows[0] || null;
}

async function getPersistentJobRow(
  id,
  userId,
  accessToken
) {
  const response = await supabaseRequest(
    `${SUPABASE_URL}/rest/v1/jobs?id=eq.${encodeURIComponent(
      id
    )}&user_id=eq.${encodeURIComponent(
      userId
    )}&limit=1`,
    {},
    accessToken,
    DATABASE_TIMEOUT
  );

  if (!response.ok) {
    const detail = await getResponseError(response);

    throw new Error(
      detail ||
        `Não foi possível consultar o job (HTTP ${response.status}).`
    );
  }

  const text = await response.text();

  if (!text) {
    return null;
  }

  let rows;

  try {
    rows = JSON.parse(text);
  } catch {
    throw new Error(
      "O Supabase retornou uma resposta inválida ao consultar o job."
    );
  }

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

/* =========================================================
   STORAGE
========================================================= */

async function downloadStorageObject(
  storagePath,
  accessToken,
  outputPath
) {
  const response = await supabaseRequest(
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(
      storagePath
    )}`,
    {},
    accessToken,
    STORAGE_DOWNLOAD_TIMEOUT
  );

  if (!response.ok || !response.body) {
    const detail = await getResponseError(response);

    throw new Error(
      detail ||
        `Não foi possível baixar o arquivo do Storage (${response.status}).`
    );
  }

  await fsp.mkdir(
    path.dirname(outputPath),
    {
      recursive: true
    }
  );

  const output = fs.createWriteStream(
    outputPath
  );

  await new Promise((resolve, reject) => {
    const source = Readable.fromWeb(
      response.body
    );

    source.on("error", reject);
    output.on("error", reject);
    output.on("finish", resolve);

    source.pipe(output);
  });
}

async function downloadStorageJson(
  storagePath,
  accessToken
) {
  const response = await supabaseRequest(
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(
      storagePath
    )}`,
    {},
    accessToken,
    DATABASE_TIMEOUT
  );

  if (response.status === 404) {
    return null;
  }

  if (!response.ok) {
    const detail =
      await getResponseError(response);

    throw new Error(
      detail ||
        `Não foi possível ler o arquivo de trabalho (${response.status}).`
    );
  }

  const text =
    await response.text();

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch {
    throw new Error(
      "O arquivo de trabalho do GeraMix está inválido."
    );
  }
}

async function uploadJsonToStorage(
  storagePath,
  data,
  accessToken
) {
  const body =
    JSON.stringify(data);

  const response =
    await supabaseRequest(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(
        storagePath
      )}`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          "Content-Length":
            String(
              Buffer.byteLength(body)
            ),

          "x-upsert": "false"
        },

        body
      },
      accessToken,
      DATABASE_TIMEOUT
    );

  if (!response.ok) {
    const detail =
      await getResponseError(
        response
      );

    throw new Error(
      detail ||
        `Não foi possível salvar o arquivo de trabalho (${response.status}).`
    );
  }
}

async function uploadVideoToStorage(
  localPath,
  storagePath,
  accessToken
) {
  const stat = await fsp.stat(
    localPath
  );

  console.log(
    `[GeraMix] Enviando Storage: ${storagePath} (${stat.size} bytes)`
  );

  const stream = fs.createReadStream(
    localPath
  );

  try {
    const response =
      await supabaseRequest(
        `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(
          storagePath
        )}`,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "video/mp4",

            "Content-Length":
              String(stat.size),

            "x-upsert":
              "false"
          },

          body: stream,

          duplex: "half"
        },
        accessToken,
        STORAGE_UPLOAD_TIMEOUT
      );

    if (!response.ok) {
      const detail =
        await getResponseError(response);

      throw new Error(
        detail ||
          `Supabase Storage recusou o vídeo (${response.status}).`
      );
    }

    console.log(
      `[GeraMix] Upload concluído: ${storagePath}`
    );
  } finally {
    stream.destroy();
  }
}

async function deleteStorageObject(
  storagePath,
  accessToken
) {
  if (!storagePath) {
    return;
  }

  const response = await supabaseRequest(
    `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(
      storagePath
    )}`,
    {
      method: "DELETE"
    },
    accessToken,
    DATABASE_TIMEOUT
  );

  if (
    !response.ok &&
    response.status !== 404
  ) {
    const detail =
      await getResponseError(
        response
      );

    throw new Error(
      detail ||
        `Supabase não conseguiu excluir o arquivo (${response.status}).`
    );
  }
}

/* =========================================================
   FFMPEG
========================================================= */

function runFFmpeg(
  args,
  cwd,
  timeoutMs = FFMPEG_TIMEOUT
) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-threads",
        "1",
        ...args
      ],
      {
        cwd
      }
    );

    let stderr = "";
    let finished = false;
    let timer;

    const finishError = error => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      reject(error);
    };

    const finishSuccess = () => {
      if (finished) {
        return;
      }

      finished = true;
      clearTimeout(timer);
      resolve();
    };

    child.stderr.on("data", data => {
      stderr += data.toString();

      if (stderr.length > 12000) {
        stderr = stderr.slice(-12000);
      }
    });

    child.on("error", finishError);

    child.on("close", code => {
      if (code === 0) {
        finishSuccess();
      } else {
        finishError(
          new Error(
            stderr.trim() ||
              `FFmpeg saiu com código ${code}.`
          )
        );
      }
    });

    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}

      finishError(
        new Error(
          `FFmpeg ultrapassou o tempo limite de ${Math.round(
            timeoutMs / 60000
          )} minutos.`
        )
      );
    }, timeoutMs);
  });
}

/* =========================================================
   ÁUDIO
========================================================= */

async function hasAudio(
  input,
  cwd
) {
  try {
    await runFFmpeg(
      [
        "-i",
        input,
        "-map",
        "0:a:0",
        "-frames:a",
        "1",
        "-f",
        "null",
        "-"
      ],
      cwd
    );

    return true;
  } catch {
    return false;
  }
}

/* =========================================================
   NORMALIZAÇÃO
========================================================= */

async function normalizeVideo(
  input,
  output,
  cwd
) {
  const audio =
    await hasAudio(
      input,
      cwd
    );

  const args = [
    "-i",
    input
  ];

  if (!audio) {
    args.push(
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo"
    );
  }

  args.push(
    "-map",
    "0:v:0",

    "-map",
    audio
      ? "0:a:0"
      : "1:a:0",

    "-vf",
    "scale=720:1280:force_original_aspect_ratio=decrease," +
      "pad=720:1280:(ow-iw)/2:(oh-ih)/2," +
      "setsar=1," +
      "fps=30," +
      "format=yuv420p",

    "-c:v",
    "libx264",

    "-preset",
    "ultrafast",

    "-crf",
    "28",

    "-pix_fmt",
    "yuv420p",

    "-r",
    "30",

    "-c:a",
    "aac",

    "-ar",
    "48000",

    "-ac",
    "2",

    "-b:a",
    "96k",

    "-shortest",

    "-y",
    output
  );

  await runFFmpeg(
    args,
    cwd
  );
}

/* =========================================================
   CONCATENA
========================================================= */

async function concatNormalized(
  files,
  output,
  cwd
) {
  const listFile =
    path.join(
      cwd,
      `concat-${crypto.randomUUID()}.txt`
    );

  const content =
    files
      .map(file => {
        const base =
          path
            .basename(file)
            .replace(
              /'/g,
              "'\\''"
            );

        return `file '${base}'`;
      })
      .join("\n");

  await fsp.writeFile(
    listFile,
    content,
    "utf8"
  );

  try {
    await runFFmpeg(
      [
        "-f",
        "concat",

        "-safe",
        "0",

        "-i",
        listFile,

        "-c",
        "copy",

        "-movflags",
        "+faststart",

        "-y",
        output
      ],
      cwd
    );
  } finally {
    await fsp.rm(
      listFile,
      {
        force: true
      }
    );
  }
}

/* =========================================================
   ORIGINALIDADE
========================================================= */

function originality(
  current,
  previous
) {
  if (!previous) {
    return 100;
  }

  let different = 0;

  if (
    current.hook !==
    previous.hook
  ) {
    different++;
  }

  if (
    current.body !==
    previous.body
  ) {
    different++;
  }

  if (
    current.cta !==
    previous.cta
  ) {
    different++;
  }

  return 70 + different * 10;
}

/* =========================================================
   COMBINAÇÃO PELO ÍNDICE
========================================================= */

function combinationFromIndex(
  index,
  hooksLength,
  bodiesLength,
  ctasLength
) {
  const zero =
    index - 1;

  const perHook =
    bodiesLength *
    ctasLength;

  const hookIndex =
    Math.floor(
      zero / perHook
    );

  const bodyIndex =
    Math.floor(
      (
        zero %
        perHook
      ) /
        ctasLength
    );

  const ctaIndex =
    zero %
    ctasLength;

  return {
    hookIndex,
    bodyIndex,
    ctaIndex
  };
}

/* =========================================================
   DOWNLOADS
========================================================= */

async function registerDownload({
  userId,
  jobId,
  fileName,
  storagePath,
  originalityScore,
  accessToken
}) {
  const response =
    await supabaseRequest(
      `${SUPABASE_URL}/rest/v1/downloads`,
      {
        method: "POST",

        headers: {
          "Content-Type":
            "application/json",

          Prefer:
            "return=representation"
        },

        body:
          JSON.stringify({
            user_id:
              userId,

            job_id:
              jobId,

            file_name:
              fileName,

            storage_path:
              storagePath,

            originality:
              originalityScore
          })
      },
      accessToken,
      DATABASE_TIMEOUT
    );

  if (!response.ok) {
    const detail =
      await getResponseError(
        response
      );

    throw new Error(
      detail ||
        `Não foi possível registrar o vídeo (${response.status}).`
    );
  }

  const text =
    await response.text();

  let rows = [];

  if (text) {
    try {
      rows =
        JSON.parse(text);
    } catch {
      throw new Error(
        "O Supabase respondeu ao registro do vídeo com um formato inválido."
      );
    }
  }

  if (
    !Array.isArray(rows) ||
    !rows.length ||
    !rows[0]?.id
  ) {
    throw new Error(
      "O vídeo foi enviado ao Storage, mas o Supabase não confirmou o registro na tabela downloads."
    );
  }

  return rows[0];
}

/* =========================================================
   PROCURA DOWNLOAD PELO JOB + NOME
========================================================= */

async function findDownloadByJobFile(
  jobId,
  userId,
  fileName,
  accessToken
) {
  const response =
    await supabaseRequest(
      `${SUPABASE_URL}/rest/v1/downloads?job_id=eq.${encodeURIComponent(
        jobId
      )}&user_id=eq.${encodeURIComponent(
        userId
      )}&file_name=eq.${encodeURIComponent(
        fileName
      )}&limit=1`,
      {},
      accessToken,
      DATABASE_TIMEOUT
    );

  if (!response.ok) {
    return null;
  }

  const text =
    await response.text();

  if (!text) {
    return null;
  }

  try {
    const rows =
      JSON.parse(text);

    return Array.isArray(rows)
      ? rows[0] || null
      : null;
  } catch {
    return null;
  }
}

/* =========================================================
   CAMINHO DO DOWNLOAD
========================================================= */

function storagePathForDownload(
  userId,
  jobId,
  fileName
) {
  return [
    userId,
    jobId,
    safeName(fileName)
  ].join("/");
}

/* =========================================================
   CRIA E SALVA UM VÍDEO
========================================================= */

async function createAndStoreDownload(
  job,
  file,
  accessToken,
  normalized,
  onStage
) {
  const dir =
    path.join(
      JOBS,
      job.id
    );

  await fsp.mkdir(
    dir,
    {
      recursive: true
    }
  );

  const output =
    path.join(
      dir,
      `assembled-${String(
        file.index
      ).padStart(
        3,
        "0"
      )}-${crypto.randomUUID()}.mp4`
    );

  const sources = [
    normalized.hooks[
      file.hookIndex - 1
    ],

    normalized.bodies[
      file.bodyIndex - 1
    ],

    normalized.ctas[
      file.ctaIndex - 1
    ]
  ];

  try {
    await onStage?.(
      `Montando vídeo ${file.index}/${job.total}…`
    );

    await concatNormalized(
      sources,
      output,
      dir
    );

    const storagePath =
      storagePathForDownload(
        job.userId,
        job.id,
        file.name
      );

    /*
     * Se uma execução anterior já terminou esse vídeo,
     * não gera novamente.
     */
    const existing =
      await findDownloadByJobFile(
        job.id,
        job.userId,
        file.name,
        accessToken
      );

    if (existing?.storage_path) {
      return existing.storage_path;
    }

    await onStage?.(
      `Enviando vídeo ${file.index}/${job.total}…`
    );

    try {
      await uploadVideoToStorage(
        output,
        storagePath,
        accessToken
      );
    } catch (error) {
      /*
       * Pode acontecer de outra execução ter enviado
       * exatamente o mesmo vídeo.
       */
      const already =
        await findDownloadByJobFile(
          job.id,
          job.userId,
          file.name,
          accessToken
        );

      if (already?.storage_path) {
        return already.storage_path;
      }

      throw error;
    }

    await onStage?.(
      `Registrando vídeo ${file.index}/${job.total}…`
    );

    try {
      await registerDownload({
        userId:
          job.userId,

        jobId:
          job.id,

        fileName:
          file.name,

        storagePath,

        originalityScore:
          file.originality,

        accessToken
      });
    } catch (error) {
      /*
       * Se outra execução registrou primeiro,
       * consideramos o vídeo concluído.
       */
      const already =
        await findDownloadByJobFile(
          job.id,
          job.userId,
          file.name,
          accessToken
        );

      if (already?.storage_path) {
        return already.storage_path;
      }

      await deleteStorageObject(
        storagePath,
        accessToken
      ).catch(
        cleanupError => {
          console.error(
            "GeraMix cleanup:",
            cleanupError
          );
        }
      );

      throw error;
    }

    await onStage?.(
      `Vídeo ${file.index}/${job.total} salvo.`
    );

    return storagePath;

  } finally {
    await fsp.rm(
      output,
      {
        force: true
      }
    ).catch(
      () => {}
    );
  }
}

/* =========================================================
   INPUTS
========================================================= */

function validateStorageInputs(
  inputs,
  userId
) {
  const lists = [
    [
      "hooks",
      inputs?.hooks,
      MAX_HOOKS
    ],

    [
      "bodies",
      inputs?.bodies,
      MAX_BODIES
    ],

    [
      "ctas",
      inputs?.ctas,
      MAX_CTAS
    ]
  ];

  return lists.map(
    ([field, list, max]) => {
      if (
        !Array.isArray(list) ||
        !list.length
      ) {
        throw new Error(
          "Envie pelo menos 1 vídeo em cada categoria."
        );
      }

      if (list.length > max) {
        throw new Error(
          `Limite excedido para ${field}.`
        );
      }

      return list.map(
        (item, index) => {
          const storagePath =
            String(
              item?.storagePath || ""
            ).trim();

          const originalName =
            String(
              item?.originalName ||
                item?.originalname ||
                `${field}-${index + 1}.mp4`
            ).trim();

          const prefix =
            `${userId}/inputs/`;

          if (
            !storagePath.startsWith(
              prefix
            )
          ) {
            throw new Error(
              `Arquivo de origem inválido em ${field}.`
            );
          }

          return {
            storagePath,

            originalname:
              originalName,

            path:
              null
          };
        }
      );
    }
  );
}

/* =========================================================
   PREPARA ARQUIVOS NORMALIZADOS
========================================================= */

async function prepareNormalizedInputs(
  job,
  manifest,
  accessToken
) {
  const dir =
    path.join(
      JOBS,
      job.id
    );

  await fsp.mkdir(
    dir,
    {
      recursive: true
    }
  );

  const result = {
    hooks: [],
    bodies: [],
    ctas: []
  };

  const categories = [
    [
      "hooks",
      manifest.hooks
    ],

    [
      "bodies",
      manifest.bodies
    ],

    [
      "ctas",
      manifest.ctas
    ]
  ];

  for (
    const [
      category,
      files
    ]
    of categories
  ) {
    for (
      let i = 0;
      i < files.length;
      i++
    ) {
      const item =
        files[i];

      const localSource =
        path.join(
          dir,
          `source-${category}-${String(
            i + 1
          ).padStart(
            3,
            "0"
          )}`
        );

      const localNormalized =
        path.join(
          dir,
          `normalized-${category}-${String(
            i + 1
          ).padStart(
            3,
            "0"
          )}.mp4`
        );

      job.current =
        `Preparando ${category} ${
          i + 1
        }/${files.length}…`;

      await updatePersistentJob(
        job,
        accessToken
      );

      await downloadStorageObject(
        item.storagePath,
        accessToken,
        localSource
      );

      await normalizeVideo(
        localSource,
        localNormalized,
        dir
      );

      const normalizedPath =
        workPath(
          job.userId,
          job.id,
          `normalized/${category}-${String(
            i + 1
          ).padStart(
            3,
            "0"
          )}.mp4`
        );

      await uploadVideoToStorage(
        localNormalized,
        normalizedPath,
        accessToken
      );

      result[category].push({
        storagePath:
          normalizedPath,

        originalname:
          item.originalname
      });

      await fsp.rm(
        localSource,
        {
          force: true
        }
      );

      await fsp.rm(
        localNormalized,
        {
          force: true
        }
      );
    }
  }

  return result;
}

/* =========================================================
   CARREGA NORMALIZADOS
========================================================= */

async function loadNormalizedInputs(
  normalizedManifest,
  job,
  accessToken
) {
  const dir =
    path.join(
      JOBS,
      job.id
    );

  await fsp.mkdir(
    dir,
    {
      recursive: true
    }
  );

  const result = {
    hooks: [],
    bodies: [],
    ctas: []
  };

  const categories = [
    [
      "hooks",
      normalizedManifest.hooks
    ],

    [
      "bodies",
      normalizedManifest.bodies
    ],

    [
      "ctas",
      normalizedManifest.ctas
    ]
  ];

  for (
    const [
      category,
      files
    ]
    of categories
  ) {
    for (
      let i = 0;
      i < files.length;
      i++
    ) {
      const localPath =
        path.join(
          dir,
          `normalized-${category}-${String(
            i + 1
          ).padStart(
            3,
            "0"
          )}.mp4`
        );

      await downloadStorageObject(
        files[i].storagePath,
        accessToken,
        localPath
      );

      result[category].push(
        localPath
      );
    }
  }

  return result;
}

/* =========================================================
   LIMPA ARQUIVOS DE TRABALHO
========================================================= */

async function cleanupWorkFiles(
  job,
  manifest,
  normalizedManifest,
  accessToken
) {
  const paths = [];

  paths.push(
    workPath(
      job.userId,
      job.id,
      "manifest.json"
    )
  );

  paths.push(
    workPath(
      job.userId,
      job.id,
      "normalized-manifest.json"
    )
  );

  if (
    normalizedManifest
  ) {
    for (
      const category
      of [
        "hooks",
        "bodies",
        "ctas"
      ]
    ) {
      for (
        const item
        of normalizedManifest[
          category
        ] || []
      ) {
        paths.push(
          item.storagePath
        );
      }
    }
  }

  for (
    const storagePath
    of paths
  ) {
    await deleteStorageObject(
      storagePath,
      accessToken
    ).catch(
      error => {
        console.error(
          "GeraMix work cleanup:",
          error
        );
      }
    );
  }

  if (
    manifest?.hooks ||
    manifest?.bodies ||
    manifest?.ctas
  ) {
    for (
      const file
      of [
        ...(manifest.hooks || []),
        ...(manifest.bodies || []),
        ...(manifest.ctas || [])
      ]
    ) {
      /*
       * Os arquivos originais somente são apagados
       * depois que todos os vídeos terminarem.
       */
      await deleteStorageObject(
        file.storagePath,
        accessToken
      ).catch(
        error => {
          console.error(
            "GeraMix input cleanup:",
            error
          );
        }
      );
    }
  }
}

/* =========================================================
   CRIA MANIFESTO
========================================================= */

async function createJobManifest(
  job,
  hooks,
  bodies,
  ctas,
  accessToken
) {
  const manifest = {
    version: 1,

    jobId:
      job.id,

    userId:
      job.userId,

    hooks:
      hooks.map(
        item => ({
          storagePath:
            item.storagePath,

          originalname:
            item.originalname
        })
      ),

    bodies:
      bodies.map(
        item => ({
          storagePath:
            item.storagePath,

          originalname:
            item.originalname
        })
      ),

    ctas:
      ctas.map(
        item => ({
          storagePath:
            item.storagePath,

          originalname:
            item.originalname
        })
      )
  };

  const storagePath =
    workPath(
      job.userId,
      job.id,
      "manifest.json"
    );

  await uploadJsonToStorage(
    storagePath,
    manifest,
    accessToken
  );

  return manifest;
}

/* =========================================================
   PROCESSA UM BLOCO
========================================================= */

async function processJobChunk({
  job,
  accessToken,
  manifest,
  normalizedManifest
}) {
  const dir =
    path.join(
      JOBS,
      job.id
    );

  await fsp.mkdir(
    dir,
    {
      recursive: true
    }
  );

  let normalized;

  try {
    /*
     * PRIMEIRA ETAPA:
     * normaliza os arquivos somente uma vez.
     */
    if (!normalizedManifest) {
      job.current =
        "Preparando vídeos de origem…";

      await updatePersistentJob(
        job,
        accessToken
      );

      normalizedManifest =
        await prepareNormalizedInputs(
          job,
          manifest,
          accessToken
        );

      await uploadJsonToStorage(
        workPath(
          job.userId,
          job.id,
          "normalized-manifest.json"
        ),
        normalizedManifest,
        accessToken
      );
    }

    /*
     * Cada execução baixa os arquivos normalizados
     * necessários para esse pequeno bloco.
     */
    normalized =
      await loadNormalizedInputs(
        normalizedManifest,
        job,
        accessToken
      );

    const start =
      Number(job.done || 0) + 1;

    const end =
      Math.min(
        Number(job.total),
        start +
          PROCESS_CHUNK_SIZE -
          1
      );

    for (
      let index = start;
      index <= end;
      index++
    ) {
      const combo =
        combinationFromIndex(
          index,
          normalized.hooks.length,
          normalized.bodies.length,
          normalized.ctas.length
        );

      const previous =
        index > 1
          ? combinationFromIndex(
              index - 1,
              normalized.hooks.length,
              normalized.bodies.length,
              normalized.ctas.length
            )
          : null;

      const currentNames = {
        hook:
          manifest.hooks[
            combo.hookIndex
          ]?.storagePath,

        body:
          manifest.bodies[
            combo.bodyIndex
          ]?.storagePath,

        cta:
          manifest.ctas[
            combo.ctaIndex
          ]?.storagePath
      };

      const previousNames =
        previous
          ? {
              hook:
                manifest.hooks[
                  previous.hookIndex
                ]?.storagePath,

              body:
                manifest.bodies[
                  previous.bodyIndex
                ]?.storagePath,

              cta:
                manifest.ctas[
                  previous.ctaIndex
                ]?.storagePath
            }
          : null;

      const file = {
        name:
          `video-${String(
            index
          ).padStart(
            3,
            "0"
          )}.mp4`,

        index,

        hook:
          safeName(
            manifest.hooks[
              combo.hookIndex
            ]?.originalname
          ),

        body:
          safeName(
            manifest.bodies[
              combo.bodyIndex
            ]?.originalname
          ),

        cta:
          safeName(
            manifest.ctas[
              combo.ctaIndex
            ]?.originalname
          ),

        hookIndex:
          combo.hookIndex + 1,

        bodyIndex:
          combo.bodyIndex + 1,

        ctaIndex:
          combo.ctaIndex + 1,

        originality:
          originality(
            currentNames,
            previousNames
          )
      };

      job.current =
        `Preparando vídeo ${index}/${job.total}…`;

      await updatePersistentJob(
        job,
        accessToken
      );

      await createAndStoreDownload(
        job,
        file,
        accessToken,
        normalized,
        async stage => {
          job.current =
            stage;

          await updatePersistentJob(
            job,
            accessToken
          );
        }
      );

      job.done =
        index;

      job.current =
        `Vídeo ${index}/${job.total} concluído.`;

      await updatePersistentJob(
        job,
        accessToken
      );
    }

    /*
     * Ainda existem vídeos.
     */
    if (
      Number(job.done) <
      Number(job.total)
    ) {
      job.current =
        `Pausando para continuar: ${job.done}/${job.total}…`;

      await updatePersistentJob(
        job,
        accessToken
      );

      return false;
    }

    /*
     * TERMINOU TUDO.
     */
    job.status =
      "done";

    job.current =
      "Concluído";

    job.error =
      null;

    await updatePersistentJob(
      job,
      accessToken,
      {
        finished_at:
          new Date().toISOString()
      }
    );

    await cleanupWorkFiles(
      job,
      manifest,
      normalizedManifest,
      accessToken
    );

    await fsp.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    ).catch(
      () => {}
    );

    console.log(
      `[GeraMix] JOB CONCLUÍDO: ${job.id}`
    );

    return true;

  } catch (error) {
    console.error(
      `[GeraMix] Erro no bloco do job ${job.id}:`,
      error
    );

    throw error;

  } finally {
    /*
     * Os arquivos locais normalizados são temporários.
     */
    await fsp.rm(
      dir,
      {
        recursive: true,
        force: true
      }
    ).catch(
      () => {}
    );
  }
}

/* =========================================================
   INICIA PRÓXIMA ETAPA NA VERCEL
========================================================= */

async function triggerNextChunk(
  jobId,
  accessToken,
  origin
) {
  const url =
    `${origin}/api/jobs/${encodeURIComponent(
      jobId
    )}/continue`;

  let lastError = null;

  for (
    let attempt = 1;
    attempt <= 3;
    attempt++
  ) {
    try {
      const response =
        await fetchWithTimeout(
          url,
          {
            method:
              "POST",

            headers: {
              Authorization:
                `Bearer ${accessToken}`,

              "Content-Type":
                "application/json"
            },

            body:
              JSON.stringify({
                continue: true
              })
          },
          15000
        );

      if (!response.ok) {
        throw new Error(
          `A próxima etapa respondeu HTTP ${response.status}.`
        );
      }

      console.log(
        `[GeraMix] Próxima etapa iniciada: ${jobId}`
      );

      return;

    } catch (error) {
      lastError =
        error;

      console.error(
        `[GeraMix] Falha ao iniciar próxima etapa (${attempt}/3):`,
        error
      );

      await new Promise(
        resolve =>
          setTimeout(
            resolve,
            1500
          )
      );
    }
  }

  throw (
    lastError ||
    new Error(
      "Não foi possível iniciar a próxima etapa."
    )
  );
}

/* =========================================================
   EXECUTA JOB
========================================================= */

async function runJob(
  job,
  accessToken,
  origin
) {
  try {
    const manifest =
      await downloadStorageJson(
        workPath(
          job.userId,
          job.id,
          "manifest.json"
        ),
        accessToken
      );

    if (!manifest) {
      throw new Error(
        "O manifesto do processamento não foi encontrado."
      );
    }

    const normalizedManifest =
      await downloadStorageJson(
        workPath(
          job.userId,
          job.id,
          "normalized-manifest.json"
        ),
        accessToken
      );

    const finished =
      await processJobChunk({
        job,
        accessToken,
        manifest,
        normalizedManifest
      });

    if (
      finished
    ) {
      return;
    }

    /*
     * IMPORTANTE:
     * Não fazemos recursão aqui.
     * Uma nova chamada HTTP é criada.
     * Assim a próxima etapa ganha uma nova
     * execução da Function.
     */
    await triggerNextChunk(
      job.id,
      accessToken,
      origin
    );

  } catch (error) {
    console.error(
      `[GeraMix] processamento ${job.id}:`,
      error
    );

    job.status =
      "error";

    job.current =
      "Falhou";

    job.error =
      error?.message ||
      "Erro desconhecido ao gerar os vídeos.";

    await updatePersistentJob(
      job,
      accessToken,
      {
        finished_at:
          new Date().toISOString()
      }
    ).catch(
      saveError => {
        console.error(
          "[GeraMix] erro ao salvar falha:",
          saveError
        );
      }
    );

    /*
     * Se ainda não havia vídeos concluídos,
     * devolve a cota.
     *
     * Se já havia vídeos registrados,
     * não devolvemos tudo novamente.
     */
    if (
      Number(job.done || 0) === 0
    ) {
      await releaseVideoQuota(
        job.userId,
        accessToken,
        job.total
      );
    }
  }
}

/* =========================================================
   CRIA JOB
========================================================= */

app.post(
  "/api/jobs",

  requireAuth,

  upload.fields([
    {
      name:
        "hooks",

      maxCount:
        MAX_HOOKS
    },

    {
      name:
        "bodies",

      maxCount:
        MAX_BODIES
    },

    {
      name:
        "ctas",

      maxCount:
        MAX_CTAS
    }
  ]),

  async (
    req,
    res
  ) => {
    const storageMode =
      Boolean(
        req.body?.inputs
      );

    let hooks;
    let bodies;
    let ctas;

    try {
      if (
        storageMode
      ) {
        [
          hooks,
          bodies,
          ctas
        ] =
          validateStorageInputs(
            req.body.inputs,
            req.user.id
          );
      } else {
        hooks =
          req.files?.hooks ||
          [];

        bodies =
          req.files?.bodies ||
          [];

        ctas =
          req.files?.ctas ||
          [];
      }

    } catch (error) {
      return res
        .status(400)
        .json({
          error:
            error?.message ||
            "Dados dos vídeos inválidos."
        });
    }

    if (
      !hooks.length ||
      !bodies.length ||
      !ctas.length
    ) {
      return res
        .status(400)
        .json({
          error:
            "Envie pelo menos 1 vídeo em cada categoria."
        });
    }

    const total =
      hooks.length *
      bodies.length *
      ctas.length;

    if (
      total >
      MAX_COMBINATIONS
    ) {
      return res
        .status(400)
        .json({
          error:
            `Limite de ${MAX_COMBINATIONS} combinações por lote.`
        });
    }

    let quota;

    try {
      quota =
        await reserveVideoQuota(
          req.user.id,
          req.accessToken,
          total
        );

    } catch (error) {
      return res
        .status(503)
        .json({
          error:
            error?.message ||
            "Não foi possível verificar sua cota mensal."
        });
    }

    if (
      !quota.allowed
    ) {
      return res
        .status(403)
        .json({
          error:
            quota.message ||
            "Limite mensal de vídeos atingido.",

          videosUsed:
            quota.videosUsed,

          monthlyLimit:
            quota.monthlyLimit
        });
    }

    const id =
      crypto.randomUUID();

    const dir =
      path.join(
        JOBS,
        id
      );

    await fsp.mkdir(
      dir,
      {
        recursive: true
      }
    );

    const job = {
      id,

      userId:
        req.user.id,

      status:
        "processing",

      total,

      done:
        0,

      current:
        "Iniciando…",

      files:
        [],

      error:
        null,

      mode:
        storageMode
          ? "storage-inputs"
          : "multipart",

      videosUsed:
        quota.videosUsed,

      monthlyLimit:
        quota.monthlyLimit
    };

    try {
      await createPersistentJob(
        job,
        req.accessToken
      );

      if (
        storageMode
      ) {
        await createJobManifest(
          job,
          hooks,
          bodies,
          ctas,
          req.accessToken
        );
      }

    } catch (error) {
      await releaseVideoQuota(
        req.user.id,
        req.accessToken,
        total
      );

      await fsp.rm(
        dir,
        {
          recursive: true,
          force: true
        }
      );

      return res
        .status(500)
        .json({
          error:
            error?.message ||
            "Não foi possível registrar o processamento."
        });
    }

    jobs.set(
      id,
      job
    );

    res.json({
      id,

      total,

      videosUsed:
        quota.videosUsed,

      monthlyLimit:
        quota.monthlyLimit
    });

    const origin =
      getPublicOrigin(
        req
      );

    /*
     * O primeiro bloco começa agora.
     * Os próximos blocos serão chamadas HTTP
     * independentes.
     */
    if (
      process.env.VERCEL
    ) {
      waitUntil(
        runJob(
          job,
          req.accessToken,
          origin
        )
      );
    } else {
      void runJob(
        job,
        req.accessToken,
        origin
      );
    }
  }
);

/* =========================================================
   CONTINUAÇÃO DO JOB
========================================================= */

app.post(
  "/api/jobs/:id/continue",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      const persistent =
        await getPersistentJobRow(
          req.params.id,
          req.user.id,
          req.accessToken
        );

      if (!persistent) {
        return res
          .status(404)
          .json({
            error:
              "Processamento não encontrado."
          });
      }

      if (
        persistent.status ===
        "done"
      ) {
        return res.json({
          ok:
            true,

          status:
            "done"
        });
      }

      if (
        persistent.status ===
        "error"
      ) {
        return res.json({
          ok:
            false,

          status:
            "error"
        });
      }

      const job = {
        id:
          persistent.id,

        userId:
          persistent.user_id,

        status:
          persistent.status,

        total:
          Number(
            persistent.total || 0
          ),

        done:
          Number(
            persistent.done || 0
          ),

        current:
          persistent.current ||
          "Continuando…",

        files:
          [],

        error:
          persistent.error,

        mode:
          persistent.mode,

        videosUsed:
          Number(
            persistent.videos_used ||
              0
          ),

        monthlyLimit:
          Number(
            persistent.monthly_limit ||
              0
          )
      };

      jobs.set(
        job.id,
        job
      );

      res.json({
        ok:
          true,

        status:
          "processing",

        done:
          job.done,

        total:
          job.total
      });

      const origin =
        getPublicOrigin(
          req
        );

      if (
        process.env.VERCEL
      ) {
        waitUntil(
          runJob(
            job,
            req.accessToken,
            origin
          )
        );
      } else {
        void runJob(
          job,
          req.accessToken,
          origin
        );
      }

    } catch (error) {
      console.error(
        "GeraMix continue:",
        error
      );

      if (
        !res.headersSent
      ) {
        return res
          .status(500)
          .json({
            error:
              error?.message ||
              "Não foi possível continuar o processamento."
          });
      }
    }
  }
);

/* =========================================================
   DOWNLOADS DE UM JOB
========================================================= */

function jobFromRows(
  id,
  userId,
  rows
) {
  return rows
    .filter(
      row =>
        row?.file_name &&
        row?.storage_path
    )
    .map(
      row => ({
        name:
          safeName(
            row.file_name
          ),

        index:
          Number(
            String(
              row.file_name
            )
              .match(
                /video-(\d+)\.mp4/
              )?.[1] ||
              0
          ),

        originality:
          Number.isFinite(
            Number(
              row.originality
            )
          )
            ? Number(
                row.originality
              )
            : null,

        stored:
          true,

        storagePath:
          row.storage_path,

        hook:
          null,

        body:
          null,

        cta:
          null,

        hookIndex:
          null,

        bodyIndex:
          null,

        ctaIndex:
          null
      })
    )
    .sort(
      (a, b) =>
        a.index -
        b.index
    );
}

/* =========================================================
   RECUPERA JOB
========================================================= */

async function getJobForUser(
  id,
  userId,
  accessToken
) {
  const persistent =
    await getPersistentJobRow(
      id,
      userId,
      accessToken
    );

  if (!persistent) {
    return null;
  }

  const downloadsResponse =
    await supabaseRequest(
      `${SUPABASE_URL}/rest/v1/downloads?job_id=eq.${encodeURIComponent(
        id
      )}&user_id=eq.${encodeURIComponent(
        userId
      )}`,
      {},
      accessToken,
      DATABASE_TIMEOUT
    );

  if (!downloadsResponse.ok) {
    const detail =
      await getResponseError(
        downloadsResponse
      );

    throw new Error(
      detail ||
        `Não foi possível consultar os vídeos do job (HTTP ${downloadsResponse.status}).`
    );
  }

  const text =
    await downloadsResponse.text();

  let rows = [];

  if (text) {
    try {
      const data =
        JSON.parse(text);

      if (
        Array.isArray(data)
      ) {
        rows =
          data;
      }
    } catch {
      throw new Error(
        "O Supabase retornou uma resposta inválida ao consultar downloads."
      );
    }
  }

  const files =
    jobFromRows(
      id,
      userId,
      rows
    );

  return {
    id:
      persistent.id,

    userId:
      persistent.user_id,

    status:
      persistent.status,

    total:
      Number(
        persistent.total || 0
      ),

    done:
      Number(
        persistent.done || 0
      ),

    current:
      persistent.current,

    error:
      persistent.error,

    files,

    mode:
      persistent.mode,

    videosUsed:
      Number(
        persistent.videos_used ||
          0
      ),

    monthlyLimit:
      Number(
        persistent.monthly_limit ||
          0
      ),

    zip:
      persistent.status ===
      "done"
        ? `/api/jobs/${id}/zip`
        : undefined
  };
}

/* =========================================================
   CONSULTA JOB
========================================================= */

app.get(
  "/api/jobs/:id",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      const job =
        await getJobForUser(
          req.params.id,
          req.user.id,
          req.accessToken
        );

      if (!job) {
        return res
          .status(404)
          .json({
            error:
              "Processamento não encontrado."
          });
      }

      return res.json(
        job
      );

    } catch (error) {
      console.error(
        "GeraMix job:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error?.message ||
            "Não foi possível consultar o processamento."
        });
    }
  }
);

/* =========================================================
   DOWNLOAD INDIVIDUAL
========================================================= */

async function findDownload(
  id,
  userId,
  accessToken
) {
  const response =
    await supabaseRequest(
      `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(
        id
      )}&user_id=eq.${encodeURIComponent(
        userId
      )}&limit=1`,
      {},
      accessToken,
      DATABASE_TIMEOUT
    );

  if (!response.ok) {
    const detail =
      await getResponseError(
        response
      );

    throw new Error(
      detail ||
        `Não foi possível consultar o download (HTTP ${response.status}).`
    );
  }

  const text =
    await response.text();

  if (!text) {
    return null;
  }

  let rows;

  try {
    rows =
      JSON.parse(text);
  } catch {
    throw new Error(
      "O Supabase retornou uma resposta inválida ao consultar o download."
    );
  }

  return Array.isArray(rows)
    ? rows[0] || null
    : null;
}

/* =========================================================
   STREAM STORAGE
========================================================= */

async function streamStoredVideo(
  file,
  req,
  res,
  forceDownload = false
) {
  const headers = {};

  if (
    req.headers.range
  ) {
    headers.Range =
      req.headers.range;
  }

  const response =
    await supabaseRequest(
      `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(
        file.storagePath
      )}`,
      {
        headers
      },
      req.accessToken,
      STORAGE_DOWNLOAD_TIMEOUT
    );

  if (!response.ok) {
    return res.sendStatus(
      response.status ===
        404
        ? 404
        : 500
    );
  }

  res.status(
    response.status
  );

  res.setHeader(
    "Content-Type",
    response.headers.get(
      "content-type"
    ) ||
      "video/mp4"
  );

  res.setHeader(
    "Accept-Ranges",
    "bytes"
  );

  res.setHeader(
    "Cache-Control",
    "private, no-store"
  );

  res.setHeader(
    "Content-Disposition",
    `${
      forceDownload
        ? "attachment"
        : "inline"
    }; filename="${safeName(
      file.name
    )}"`
  );

  const length =
    response.headers.get(
      "content-length"
    );

  const range =
    response.headers.get(
      "content-range"
    );

  if (length) {
    res.setHeader(
      "Content-Length",
      length
    );
  }

  if (range) {
    res.setHeader(
      "Content-Range",
      range
    );
  }

  if (!response.body) {
    return res.end();
  }

  return Readable
    .fromWeb(
      response.body
    )
    .pipe(
      res
    );
}

/* =========================================================
   VÍDEO DO JOB
========================================================= */

app.get(
  "/api/jobs/:id/video/:name",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      const job =
        await getJobForUser(
          req.params.id,
          req.user.id,
          req.accessToken
        );

      if (!job) {
        return res.sendStatus(
          404
        );
      }

      const name =
        safeName(
          req.params.name
        );

      const file =
        job.files.find(
          item =>
            item.name ===
            name
        );

      if (!file) {
        return res.sendStatus(
          404
        );
      }

      if (
        !file.storagePath
      ) {
        return res
          .status(409)
          .json({
            error:
              "Este vídeo ainda está sendo gerado."
          });
      }

      return streamStoredVideo(
        file,
        req,
        res
      );

    } catch (error) {
      console.error(
        "GeraMix video:",
        error
      );

      return res.sendStatus(
        500
      );
    }
  }
);

/* =========================================================
   ZIP
========================================================= */

app.get(
  "/api/jobs/:id/zip",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      const job =
        await getJobForUser(
          req.params.id,
          req.user.id,
          req.accessToken
        );

      if (!job) {
        return res
          .status(404)
          .send(
            "Processamento não encontrado."
          );
      }

      if (
        job.status !==
        "done"
      ) {
        return res
          .status(400)
          .send(
            "O processamento ainda não terminou."
          );
      }

      res.setHeader(
        "Content-Type",
        "application/zip"
      );

      res.setHeader(
        "Content-Disposition",
        'attachment; filename="geramix-videos.zip"'
      );

      const archive =
        archiver(
          "zip",
          {
            zlib: {
              level: 0
            }
          }
        );

      archive.on(
        "error",
        error =>
          res.destroy(
            error
          )
      );

      archive.pipe(
        res
      );

      for (
        const file
        of job.files
      ) {
        if (
          !file.storagePath
        ) {
          continue;
        }

        const response =
          await supabaseRequest(
            `${SUPABASE_URL}/storage/v1/object/${SUPABASE_DOWNLOAD_BUCKET}/${encodedStoragePath(
              file.storagePath
            )}`,
            {},
            req.accessToken,
            STORAGE_DOWNLOAD_TIMEOUT
          );

        if (
          !response.ok ||
          !response.body
        ) {
          const detail =
            await getResponseError(
              response
            );

          throw new Error(
            detail ||
              `Não foi possível ler ${file.name} do Storage.`
          );
        }

        archive.append(
          Readable.fromWeb(
            response.body
          ),
          {
            name:
              file.name
          }
        );
      }

      await archive.finalize();

    } catch (error) {
      console.error(
        "GeraMix ZIP:",
        error
      );

      if (
        !res.headersSent
      ) {
        res
          .status(500)
          .send(
            "Erro ao criar ZIP."
          );
      } else {
        res.destroy(
          error
        );
      }
    }
  }
);

/* =========================================================
   LIMPEZA EXPIRADOS
========================================================= */

async function cleanupExpiredDownloads(
  userId,
  accessToken
) {
  const response =
    await supabaseRequest(
      `${SUPABASE_URL}/rest/v1/downloads?user_id=eq.${encodeURIComponent(
        userId
      )}&expires_at=lt.${encodeURIComponent(
        new Date().toISOString()
      )}`,
      {},
      accessToken,
      DATABASE_TIMEOUT
    );

  if (!response.ok) {
    return;
  }

  const text =
    await response.text();

  if (!text) {
    return;
  }

  let rows;

  try {
    rows =
      JSON.parse(text);
  } catch {
    return;
  }

  if (
    !Array.isArray(rows)
  ) {
    return;
  }

  for (
    const row
    of rows
  ) {
    if (
      row.storage_path
    ) {
      await deleteStorageObject(
        row.storage_path,
        accessToken
      ).catch(
        error => {
          console.error(
            "GeraMix expired storage cleanup:",
            error
          );
        }
      );
    }

    await supabaseRequest(
      `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(
        row.id
      )}&user_id=eq.${encodeURIComponent(
        userId
      )}`,
      {
        method:
          "DELETE"
      },
      accessToken,
      DATABASE_TIMEOUT
    ).catch(
      error => {
        console.error(
          "GeraMix expired row cleanup:",
          error
        );
      }
    );
  }
}

/* =========================================================
   CENTRAL DE DOWNLOADS
========================================================= */

app.get(
  "/api/downloads",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      await cleanupExpiredDownloads(
        req.user.id,
        req.accessToken
      );

      const response =
        await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/downloads?user_id=eq.${encodeURIComponent(
            req.user.id
          )}&order=created_at.desc`,
          {},
          req.accessToken,
          DATABASE_TIMEOUT
        );

      if (!response.ok) {
        const detail =
          await getResponseError(
            response
          );

        return res
          .status(500)
          .json({
            error:
              detail ||
              "Não foi possível carregar seus downloads."
          });
      }

      const text =
        await response.text();

      let rows = [];

      if (text) {
        try {
          const data =
            JSON.parse(text);

          if (
            Array.isArray(data)
          ) {
            rows =
              data;
          }
        } catch {
          return res
            .status(500)
            .json({
              error:
                "Resposta inválida ao carregar seus downloads."
            });
        }
      }

      res.json({
        downloads:
          rows.map(
            row => ({
              id:
                row.id,

              jobId:
                row.job_id,

              fileName:
                row.file_name,

              originality:
                Number.isFinite(
                  Number(
                    row.originality
                  )
                )
                  ? Number(
                      row.originality
                    )
                  : null,

              createdAt:
                row.created_at,

              expiresAt:
                row.expires_at,

              videoUrl:
                `/api/downloads/${encodeURIComponent(
                  row.id
                )}/video`,

              downloadUrl:
                `/api/downloads/${encodeURIComponent(
                  row.id
                )}/video?download=1`
            })
          )
      });

    } catch (error) {
      console.error(
        "GeraMix downloads:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error?.message ||
            "Não foi possível carregar seus downloads."
        });
    }
  }
);

/* =========================================================
   ABRIR / BAIXAR DOWNLOAD
========================================================= */

app.get(
  "/api/downloads/:id/video",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      const row =
        await findDownload(
          req.params.id,
          req.user.id,
          req.accessToken
        );

      if (
        !row?.storage_path
      ) {
        return res.sendStatus(
          404
        );
      }

      return streamStoredVideo(
        {
          name:
            row.file_name,

          storagePath:
            row.storage_path
        },

        req,

        res,

        req.query.download ===
          "1"
      );

    } catch (error) {
      console.error(
        "GeraMix download:",
        error
      );

      res.sendStatus(
        500
      );
    }
  }
);

/* =========================================================
   EXCLUI DOWNLOAD
========================================================= */

app.delete(
  "/api/downloads/:id",

  requireAuth,

  async (
    req,
    res
  ) => {
    try {
      const row =
        await findDownload(
          req.params.id,
          req.user.id,
          req.accessToken
        );

      if (!row) {
        return res.sendStatus(
          404
        );
      }

      if (
        row.storage_path
      ) {
        await deleteStorageObject(
          row.storage_path,
          req.accessToken
        );
      }

      const response =
        await supabaseRequest(
          `${SUPABASE_URL}/rest/v1/downloads?id=eq.${encodeURIComponent(
            row.id
          )}&user_id=eq.${encodeURIComponent(
            req.user.id
          )}`,
          {
            method:
              "DELETE"
          },
          req.accessToken,
          DATABASE_TIMEOUT
        );

      if (!response.ok) {
        const detail =
          await getResponseError(
            response
          );

        return res
          .status(500)
          .json({
            error:
              detail ||
              "Não foi possível excluir o vídeo."
          });
      }

      res.json({
        ok:
          true
      });

    } catch (error) {
      console.error(
        "GeraMix delete download:",
        error
      );

      res
        .status(500)
        .json({
          error:
            error?.message ||
            "Não foi possível excluir o vídeo."
        });
    }
  }
);

/* =========================================================
   ERROS
========================================================= */

app.use(
  (
    error,
    req,
    res,
    next
  ) => {
    if (
      error instanceof
      multer.MulterError
    ) {
      return res
        .status(400)
        .json({
          error:
            `Erro no envio dos vídeos: ${error.message}`
        });
    }

    if (error) {
      console.error(
        "GeraMix servidor:",
        error
      );

      return res
        .status(500)
        .json({
          error:
            error.message ||
            "Erro interno do servidor."
        });
    }

    next();
  }
);

/* =========================================================
   SERVIDOR
========================================================= */

const server =
  app.listen(
    PORT,
    () => {
      console.log(
        `GeraMix rodando na porta ${PORT}`
      );

      console.log(
        `FFmpeg disponível: ${Boolean(
          ffmpegPath
        )}`
      );

      console.log(
        `Tamanho do bloco: ${PROCESS_CHUNK_SIZE} vídeos`
      );

      console.log(
        `Limite de combinações: ${MAX_COMBINATIONS}`
      );

      console.log(
        `Timeout FFmpeg: ${Math.round(
          FFMPEG_TIMEOUT / 60000
        )} minutos`
      );

      console.log(
        `Timeout Storage upload: ${Math.round(
          STORAGE_UPLOAD_TIMEOUT / 60000
        )} minutos`
      );
    }
  );

server.timeout = 0;
