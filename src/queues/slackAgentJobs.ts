import { Queue, Worker, type JobsOptions, type WorkerOptions } from "bullmq";
import { Redis, type RedisOptions } from "ioredis";
import { z } from "zod";

const QUEUE_NAME = "slack-agent-jobs";
const JOB_NAME = "slack-agent-invocation";
const JOB_ATTEMPTS = 3;
const DEDUPE_TTL_MILLIS = 10 * 60 * 1000;

export const slackAgentJobSchema = z.object({
  botUserId: z.string().optional(),
  channelId: z.string().min(1),
  enterpriseId: z.string().optional(),
  eventId: z.string().optional(),
  eventType: z.enum(["app_mention", "message_follow_up"]),
  isEnterpriseInstall: z.boolean().optional(),
  messageTs: z.string().min(1),
  retryNum: z.string().optional(),
  retryReason: z.string().optional(),
  teamId: z.string().min(1),
  text: z.string(),
  threadTs: z.string().min(1),
  userId: z.string().min(1),
});

export type SlackAgentJob = z.infer<typeof slackAgentJobSchema>;

export type SlackAgentJobQueue = {
  close(): Promise<void>;
  enqueue(job: SlackAgentJob): Promise<SlackAgentJobEnqueueResult>;
};

export type SlackAgentJobEnqueueResult = {
  deduplicated: boolean;
  jobId: string;
};

export type SlackAgentJobWorker = {
  close(): Promise<void>;
};

export type SlackAgentJobProcessor = (
  job: SlackAgentJob,
  context: { attempts: number; attemptsMade: number },
) => Promise<void>;

export function createBullMqSlackAgentJobQueue(redisUrl: string): SlackAgentJobQueue {
  const connection = createRedisConnection(redisUrl, {
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
  });
  const queue = new Queue<SlackAgentJob>(QUEUE_NAME, { connection });
  return {
    async close() {
      await queue.close();
      await connection.quit();
    },
    async enqueue(job) {
      const parsed = slackAgentJobSchema.parse(job);
      const jobId = slackAgentJobId(parsed);
      const dedupeKey = slackAgentJobDedupeKey(jobId);
      const accepted = await connection.set(dedupeKey, "1", "PX", DEDUPE_TTL_MILLIS, "NX");
      if (accepted !== "OK") {
        return { deduplicated: true, jobId };
      }
      try {
        await queue.add(JOB_NAME, parsed, slackAgentJobOptions(jobId));
      } catch (error) {
        await connection.del(dedupeKey);
        throw error;
      }
      return { deduplicated: false, jobId };
    },
  };
}

export function createBullMqSlackAgentJobWorker(
  redisUrl: string,
  processor: SlackAgentJobProcessor,
  options: { concurrency?: number } = {},
): SlackAgentJobWorker {
  const connection = createRedisConnection(redisUrl, { maxRetriesPerRequest: null });
  const workerOptions: WorkerOptions = {
    concurrency: options.concurrency ?? 2,
    connection,
  };
  const worker = new Worker<SlackAgentJob>(
    QUEUE_NAME,
    async (job) => {
      await processor(slackAgentJobSchema.parse(job.data), {
        attempts: typeof job.opts.attempts === "number" ? job.opts.attempts : 1,
        attemptsMade: job.attemptsMade,
      });
    },
    workerOptions,
  );
  worker.on("failed", (job, error) => {
    console.error("Slack agent job failed.", {
      attemptsMade: job?.attemptsMade,
      error,
      jobId: job?.id,
    });
  });
  worker.on("completed", (job) => {
    console.log("Slack agent job completed.", { jobId: job.id });
  });
  return {
    async close() {
      await worker.close();
      await connection.quit();
    },
  };
}

export function slackAgentJobId(job: SlackAgentJob): string {
  return job.eventId ?? `${job.teamId}:${job.eventType}:${job.channelId}:${job.messageTs}`;
}

function slackAgentJobDedupeKey(jobId: string): string {
  return `slack-agent-job:dedupe:${jobId}`;
}

function slackAgentJobOptions(jobId: string): JobsOptions {
  return {
    attempts: JOB_ATTEMPTS,
    backoff: { delay: 5_000, type: "exponential" },
    jobId,
    removeOnComplete: { age: 24 * 60 * 60, count: 5_000 },
    removeOnFail: { age: 7 * 24 * 60 * 60 },
  };
}

function createRedisConnection(redisUrl: string, options: RedisOptions): Redis {
  const parsed = new URL(redisUrl);
  return new Redis(redisUrl, {
    ...options,
    tls: parsed.protocol === "rediss:" ? {} : options.tls,
  });
}
