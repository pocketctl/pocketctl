import * as tencentcloud from 'tencentcloud-sdk-nodejs-sms';

const SmsClient = tencentcloud.sms.v20210111.Client;

let _client: InstanceType<typeof SmsClient> | null = null;

function getClient() {
  if (!_client) {
    _client = new SmsClient({
      credential: {
        secretId: process.env.COS_SECRET_ID!,
        secretKey: process.env.COS_SECRET_KEY!,
      },
      region: 'ap-guangzhou',
      profile: { httpProfile: { endpoint: 'sms.tencentcloudapi.com' } },
    });
  }
  return _client;
}

export async function sendSmsCode(phone: string, code: string): Promise<void> {
  const params = {
    SmsSdkAppId: process.env.SMS_SDK_APP_ID || '',
    SignName: process.env.SMS_SIGN_NAME || '',
    TemplateId: process.env.SMS_TEMPLATE_ID || '2661504',
    TemplateParamSet: [code],
    PhoneNumberSet: [`+86${phone}`],
  };

  const res = await getClient().SendSms(params);
  const status = res.SendStatusSet?.[0];

  if (!status || status.Code !== 'Ok') {
    throw new Error(`SMS send failed: ${status?.Code} - ${status?.Message}`);
  }
}
