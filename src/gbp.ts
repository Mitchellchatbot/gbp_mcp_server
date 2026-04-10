import axios, { AxiosInstance } from "axios";

// GBP API base URLs
const ACCOUNT_MGMT = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BIZ_INFO = "https://mybusinessbusinessinformation.googleapis.com/v1";
const REVIEWS = "https://mybusiness.googleapis.com/v4";
const POSTS = "https://mybusiness.googleapis.com/v4";
const VERIFICATIONS = "https://mybusinessverifications.googleapis.com/v1";

function client(accessToken: string): AxiosInstance {
  return axios.create({
    headers: { Authorization: `Bearer ${accessToken}` },
  });
}

// ── Accounts ──────────────────────────────────────────────────────────────────

export async function listAccounts(accessToken: string): Promise<any[]> {
  const res = await client(accessToken).get(`${ACCOUNT_MGMT}/accounts`);
  return res.data.accounts || [];
}

export async function getAccount(accessToken: string, accountName: string): Promise<any> {
  const res = await client(accessToken).get(`${ACCOUNT_MGMT}/${accountName}`);
  return res.data;
}

// ── Locations ─────────────────────────────────────────────────────────────────

export async function listLocations(accessToken: string, accountName: string): Promise<any[]> {
  const res = await client(accessToken).get(`${BIZ_INFO}/${accountName}/locations`, {
    params: {
      readMask: [
        "name",
        "title",
        "phoneNumbers",
        "websiteUri",
        "storefrontAddress",
        "regularHours",
        "specialHours",
        "categories",
        "profile",
        "openInfo",
        "metadata",
        "serviceArea",
        "labels",
        "adWordsLocationExtensions",
      ].join(","),
    },
  });
  return res.data.locations || [];
}

export async function getLocation(accessToken: string, locationName: string): Promise<any> {
  const res = await client(accessToken).get(`${BIZ_INFO}/${locationName}`, {
    params: {
      readMask: [
        "name",
        "title",
        "phoneNumbers",
        "websiteUri",
        "storefrontAddress",
        "regularHours",
        "specialHours",
        "categories",
        "profile",
        "openInfo",
        "metadata",
        "serviceArea",
        "labels",
      ].join(","),
    },
  });
  return res.data;
}

export async function updateLocation(
  accessToken: string,
  locationName: string,
  fields: Record<string, any>
): Promise<any> {
  const updateMask = Object.keys(fields).join(",");
  const res = await client(accessToken).patch(
    `${BIZ_INFO}/${locationName}`,
    fields,
    { params: { updateMask } }
  );
  return res.data;
}

// ── Reviews ───────────────────────────────────────────────────────────────────

export async function listReviews(
  accessToken: string,
  locationName: string,
  pageSize = 20
): Promise<any[]> {
  const res = await client(accessToken).get(
    `${REVIEWS}/${locationName}/reviews`,
    { params: { pageSize } }
  );
  return res.data.reviews || [];
}

export async function getReview(
  accessToken: string,
  locationName: string,
  reviewId: string
): Promise<any> {
  const res = await client(accessToken).get(
    `${REVIEWS}/${locationName}/reviews/${reviewId}`
  );
  return res.data;
}

export async function replyToReview(
  accessToken: string,
  locationName: string,
  reviewId: string,
  comment: string
): Promise<any> {
  const res = await client(accessToken).put(
    `${REVIEWS}/${locationName}/reviews/${reviewId}/reply`,
    { comment }
  );
  return res.data;
}

export async function deleteReviewReply(
  accessToken: string,
  locationName: string,
  reviewId: string
): Promise<void> {
  await client(accessToken).delete(
    `${REVIEWS}/${locationName}/reviews/${reviewId}/reply`
  );
}

// ── Local Posts ───────────────────────────────────────────────────────────────

export async function listPosts(
  accessToken: string,
  locationName: string
): Promise<any[]> {
  const res = await client(accessToken).get(
    `${POSTS}/${locationName}/localPosts`
  );
  return res.data.localPosts || [];
}

export async function createPost(
  accessToken: string,
  locationName: string,
  post: {
    topicType: "STANDARD" | "EVENT" | "OFFER" | "ALERT";
    summary: string;
    callToAction?: { actionType: string; url: string };
    event?: { title: string; schedule: { startDate: any; endDate: any } };
    media?: Array<{ mediaFormat: string; sourceUrl: string }>;
  }
): Promise<any> {
  const res = await client(accessToken).post(
    `${POSTS}/${locationName}/localPosts`,
    post
  );
  return res.data;
}

export async function deletePost(
  accessToken: string,
  locationName: string,
  postName: string
): Promise<void> {
  await client(accessToken).delete(`${POSTS}/${postName}`);
}

// ── Q&A ───────────────────────────────────────────────────────────────────────

export async function listQuestions(
  accessToken: string,
  locationName: string,
  pageSize = 10
): Promise<any[]> {
  const res = await client(accessToken).get(
    `${BIZ_INFO}/${locationName}/questions`,
    { params: { pageSize } }
  );
  return res.data.questions || [];
}

export async function answerQuestion(
  accessToken: string,
  locationName: string,
  questionName: string,
  text: string
): Promise<any> {
  const res = await client(accessToken).post(
    `${BIZ_INFO}/${questionName}/answers`,
    { text }
  );
  return res.data;
}

// ── Media ─────────────────────────────────────────────────────────────────────

export async function listMedia(
  accessToken: string,
  locationName: string,
  pageSize = 20
): Promise<any[]> {
  const res = await client(accessToken).get(
    `${BIZ_INFO}/${locationName}/media`,
    { params: { pageSize } }
  );
  return res.data.mediaItems || [];
}

// ── Insights (via Search Atlas / v4 API) ──────────────────────────────────────

export async function getInsights(
  accessToken: string,
  locationNames: string[],
  startTime: string,
  endTime: string,
  metricRequests: Array<{ metric: string; options?: string[] }>
): Promise<any> {
  // Uses v4 reportInsights endpoint
  const res = await client(accessToken).post(
    `${REVIEWS}/${locationNames[0].split("/locations/")[0]}/locations:reportInsights`,
    {
      locationNames,
      basicRequest: {
        metricRequests,
        timeRange: { startTime, endTime },
      },
    }
  );
  return res.data;
}
