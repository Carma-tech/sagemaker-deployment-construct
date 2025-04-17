import * as fs from 'fs';
import { S3Client, GetObjectCommand } from "@aws-sdk/client-s3";
import { Readable } from "stream";

// Helper: Convert a Readable stream to a string.
async function streamToString(stream: Readable): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: any[] = [];
    stream.on("data", (chunk) => chunks.push(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
  });
}

async function loadConfigFromS3(bucket: string, key: string): Promise<any> {
  const client = new S3Client({});
  const command = new GetObjectCommand({ Bucket: bucket, Key: key });
  try {
    const response = await client.send(command);
    const bodyContents = await streamToString(response.Body as Readable);
    const config = JSON.parse(bodyContents);
    config['InfraConfigFile'] = `s3://${bucket}/${key}`;
    console.log("Loaded configuration from S3:", config)
    return config;
  } catch (err: any) {
    console.error("Error loading configuration from S3:", err);
    throw err;  // This will surface the error (e.g., NoSuchKey)
  }
}

function loadConfigFromFile(filePath: string): any {
  const config = JSON.parse(fs.readFileSync(filePath, "utf-8"));
  config["InfraConfigFile"] = filePath;
  return config;
}

function addProjectPrefix(config: any): any {
  const projectPrefix = `${config.Project.Name}${config.Project.Stage}`;
  for (const key in config.Stack) {
    config.Stack[key].Name = `${projectPrefix}-${config.Stack[key].Name}`;
  }
  return config;
}

export async function loadConfig(configFilePath: string): Promise<any> {
  if (process.env.CONFIG_BUCKET && process.env.CONFIG_KEY) {
    // Attempt to load from S3 using AWS SDK v3
    const config = await loadConfigFromS3(process.env.CONFIG_BUCKET, process.env.CONFIG_KEY);
    return addProjectPrefix(config);
  } else {
    // Fallback to local file
    const config = loadConfigFromFile(configFilePath);
    return addProjectPrefix(config);
  }
}
