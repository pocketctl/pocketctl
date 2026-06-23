import * as tencentcloud from 'tencentcloud-sdk-nodejs-ses';

const SesClient = tencentcloud.ses.v20201002.Client;

// Unified Tencent Cloud API keys (shared across COS/SES/SMS).
// Accept both old (COS_SECRET_*) and new (SES_SECRET_*) naming.
const SECRET_ID  = process.env.SES_SECRET_ID  || process.env.COS_SECRET_ID;
const SECRET_KEY = process.env.SES_SECRET_KEY || process.env.COS_SECRET_KEY;

let _client: InstanceType<typeof SesClient> | null = null;

function getClient() {
  if (!_client) {
    _client = new SesClient({
      credential: {
        secretId: SECRET_ID!,
        secretKey: SECRET_KEY!,
      },
      region: process.env.SES_REGION || 'ap-hongkong',
      profile: { httpProfile: { endpoint: 'ses.tencentcloudapi.com' } },
    });
  }
  return _client;
}

/** SES template IDs for verification code emails. Configured in .env. */
const ZH_TEMPLATE_ID = parseInt(process.env.SES_TEMPLATE_ZH || '187105', 10);
const EN_TEMPLATE_ID = parseInt(process.env.SES_TEMPLATE_EN || '187106', 10);

/**
 * Send a verification code email via Tencent Cloud SES.
 *
 * @param toEmail - Recipient email address
 * @param code    - 6-digit verification code
 * @param lang    - Language preference: 'zh' (default) or 'en'
 */
export async function sendEmailCode(toEmail: string, code: string, lang: 'zh' | 'en' = 'zh'): Promise<void> {
  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error('SES_FROM_EMAIL environment variable is required');
  }

  const templateId = lang === 'en' ? EN_TEMPLATE_ID : ZH_TEMPLATE_ID;

  const params: any = {
    FromEmailAddress: fromEmail,
    Destination: [toEmail],
    Subject: lang === 'en' ? 'pocketctl Login Verification Code' : 'pocketctl 登录验证码',
    ReplyToAddresses: fromEmail,
    Template: {
      TemplateID: templateId,
      // Template uses {{name}} as the placeholder for the verification code.
      TemplateData: JSON.stringify({ name: code }),
    },
  };

  const res = await getClient().SendEmail(params);
  if (res.MessageId) {
    console.log(`[email] sent to ${toEmail} (${lang}), template: ${templateId}, messageId: ${res.MessageId}`);
  } else {
    throw new Error(`Email send failed: ${res.RequestId}`);
  }
}
