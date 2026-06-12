import * as tencentcloud from 'tencentcloud-sdk-nodejs-ses';

const SesClient = tencentcloud.ses.v20201002.Client;

let _client: InstanceType<typeof SesClient> | null = null;

function getClient() {
  if (!_client) {
    _client = new SesClient({
      credential: {
        secretId: process.env.COS_SECRET_ID!,
        secretKey: process.env.COS_SECRET_KEY!,
      },
      region: process.env.SES_REGION || 'ap-hongkong',
      profile: { httpProfile: { endpoint: 'ses.tencentcloudapi.com' } },
    });
  }
  return _client;
}

export async function sendEmailCode(toEmail: string, code: string): Promise<void> {
  const fromEmail = process.env.SES_FROM_EMAIL;
  if (!fromEmail) {
    throw new Error('SES_FROM_EMAIL environment variable is required');
  }
  const templateId = process.env.SES_TEMPLATE_ID;
  const subject = process.env.SES_EMAIL_SUBJECT || 'pocketctl 登录验证码 / Login Verification Code';

  const params: any = {
    FromEmailAddress: fromEmail,
    Destination: [toEmail],
    Subject: subject,
    ReplyToAddresses: fromEmail,
  };

  if (templateId) {
    // Use pre-approved template with template data
    params.Template = {
      TemplateID: Number(templateId),
      TemplateData: JSON.stringify({ code }),
    };
  } else {
    // Fallback: send simple HTML email (may require domain verification)
    params.Simple = {
      Html: `<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; max-width: 480px; margin: 0 auto; padding: 32px 24px;">
  <h1 style="color: #1f6feb; font-size: 24px; margin-bottom: 8px;">pocketctl</h1>
  <p style="color: #1f2328; font-size: 16px; margin-bottom: 24px;">你的登录验证码 / Your verification code:</p>
  <div style="background: #f6f8fa; border-radius: 8px; padding: 20px; text-align: center; margin-bottom: 24px;">
    <span style="font-family: 'SF Mono', monospace; font-size: 32px; font-weight: 700; letter-spacing: 8px; color: #1f2328;">${code}</span>
  </div>
  <p style="color: #656d76; font-size: 13px;">验证码 5 分钟内有效，请勿转发给他人。</p>
  <p style="color: #656d76; font-size: 13px;">This code expires in 5 minutes. Do not share it with anyone.</p>
</div>`,
    };
  }

  const res = await getClient().SendEmail(params);
  if (res.MessageId) {
    console.log(`[email] sent to ${toEmail}, messageId: ${res.MessageId}`);
  } else {
    throw new Error(`Email send failed: ${res.RequestId}`);
  }
}
