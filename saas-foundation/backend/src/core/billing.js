import { config } from '../config.js';
import { fail } from '../http.js';
import {
  duitkuInquirySignature,
  duitkuPaymentMethodsSignature,
} from './billing-signatures.js';

export { duitkuInquirySignature, duitkuPaymentMethodsSignature } from './billing-signatures.js';

function requireProviderConfig(provider) {
  if (provider === 'xendit' &&
      (!config.xenditSecretKey || !config.xenditCallbackToken)) {
    throw fail(503, 'Kredensial Xendit belum dikonfigurasi.', 'PAYMENT_PROVIDER_UNAVAILABLE');
  }
  if (provider === 'duitku' &&
      (!config.duitkuMerchantCode || !config.duitkuApiKey)) {
    throw fail(503, 'Kredensial Duitku belum dikonfigurasi.', 'PAYMENT_PROVIDER_UNAVAILABLE');
  }
}

async function postJson(url, body, headers = {}) {
  let response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw fail(502, 'Payment gateway tidak dapat dihubungi.', 'PAYMENT_GATEWAY_UNAVAILABLE');
  }
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload || typeof payload !== 'object') {
    throw fail(502, `Payment gateway menolak permintaan (${response.status}).`, 'PAYMENT_GATEWAY_ERROR');
  }
  return payload;
}

function requirePublicUrl(value, name) {
  let url;
  try { url = new URL(value); } catch { throw fail(503, `${name} belum dikonfigurasi.`, 'PAYMENT_PROVIDER_UNAVAILABLE'); }
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw fail(503, `${name} harus menggunakan URL HTTPS publik.`, 'PAYMENT_PROVIDER_UNAVAILABLE');
  }
  return url;
}

function duitkuBaseUrl() {
  return config.duitkuEnvironment === 'sandbox'
    ? 'https://sandbox.duitku.com/webapi/api/merchant'
    : 'https://passport.duitku.com/webapi/api/merchant';
}

export async function getDuitkuPaymentMethods(amount) {
  requireProviderConfig('duitku');
  const datetime = new Date().toISOString().replace('T', ' ').slice(0, 19);
  const body = {
    merchantcode: config.duitkuMerchantCode,
    amount,
    datetime,
    signature: duitkuPaymentMethodsSignature(
      config.duitkuMerchantCode,
      amount,
      datetime,
      config.duitkuApiKey,
    ),
  };
  const result = await postJson(
    `${duitkuBaseUrl()}/paymentmethod/getpaymentmethod`,
    body,
  );
  if (result.responseCode !== '00' || !Array.isArray(result.paymentFee)) {
    throw fail(502, 'Daftar metode pembayaran Duitku tidak dapat dimuat.', 'PAYMENT_GATEWAY_ERROR');
  }
  return result.paymentFee.filter((method) =>
    method && typeof method.paymentMethod === 'string' &&
    typeof method.paymentName === 'string',
  ).map((method) => ({
    code: method.paymentMethod,
    name: method.paymentName,
    fee: Number.isFinite(Number(method.totalFee)) ? Number(method.totalFee) : 0,
  }));
}

export async function createProviderPayment({
  order,
  school,
  email,
  phone,
}) {
  requireProviderConfig(order.provider);
  const publicWeb = requirePublicUrl(config.publicWebUrl, 'PUBLIC_WEB_URL');
  const publicApi = requirePublicUrl(config.publicApiUrl, 'PUBLIC_API_URL');
  const returnUrl = new URL('/?billing=return', publicWeb).toString();

  if (order.provider === 'xendit') {
    const result = await postJson(
      'https://api.xendit.co/v2/invoices',
      {
        external_id: order.order_id,
        amount: Number(order.amount),
        currency: 'IDR',
        description: `Perpanjangan ${school.name} - ${order.plan === 'lifetime' ? 'Lifetime' : '1 bulan'}`,
        invoice_duration: 86400,
        customer: { given_names: school.name, email },
        success_redirect_url: returnUrl,
        failure_redirect_url: returnUrl,
        metadata: { order_id: order.order_id, school_id: String(school.id) },
      },
      {
        authorization: `Basic ${Buffer.from(`${config.xenditSecretKey}:`).toString('base64')}`,
        'idempotency-key': order.order_id,
      },
    );
    let checkout = null;
    if (typeof result.invoice_url === 'string') {
      try { checkout = new URL(result.invoice_url); } catch { checkout = null; }
    }
    if (!checkout || checkout.protocol !== 'https:' ||
        !['checkout.xendit.co', 'checkout-staging.xendit.co'].includes(checkout.hostname)) {
      throw fail(502, 'Xendit tidak mengembalikan link pembayaran yang valid.', 'PAYMENT_GATEWAY_ERROR');
    }
    return {
      checkoutUrl: checkout.toString(),
      reference: typeof result.id === 'string' ? result.id : null,
      expiresAt: typeof result.expiry_date === 'string' &&
        !Number.isNaN(new Date(result.expiry_date).getTime())
        ? new Date(result.expiry_date)
        : new Date(Date.now() + 86400000),
    };
  }

  const callbackUrl = new URL('/api/payments/duitku/callback', publicApi).toString();
  const signature = duitkuInquirySignature(
    config.duitkuMerchantCode,
    order.order_id,
    Number(order.amount),
    config.duitkuApiKey,
  );
  const result = await postJson(`${duitkuBaseUrl()}/v2/inquiry`, {
    merchantCode: config.duitkuMerchantCode,
    paymentAmount: Number(order.amount),
    paymentMethod: order.payment_method,
    merchantOrderId: order.order_id,
    productDetails: `Perpanjangan ${school.name} - ${order.plan === 'lifetime' ? 'Lifetime' : '1 bulan'}`,
    customerVaName: school.name.slice(0, 20),
    email,
    phoneNumber: phone ?? '',
    callbackUrl,
    returnUrl,
    expiryPeriod: 1440,
    signature,
  });
  if (result.statusCode !== '00' || typeof result.paymentUrl !== 'string') {
    throw fail(502, 'Duitku tidak mengembalikan link pembayaran yang valid.', 'PAYMENT_GATEWAY_ERROR');
  }
  let checkout;
  try { checkout = new URL(result.paymentUrl); } catch {
    throw fail(502, 'Duitku mengembalikan link pembayaran yang tidak valid.', 'PAYMENT_GATEWAY_ERROR');
  }
  if (checkout.protocol !== 'https:' ||
      !['passport.duitku.com', 'sandbox.duitku.com'].includes(checkout.hostname)) {
    throw fail(502, 'Duitku mengembalikan host pembayaran yang tidak dikenal.', 'PAYMENT_GATEWAY_ERROR');
  }
  return {
    checkoutUrl: checkout.toString(),
    reference: typeof result.reference === 'string' ? result.reference : null,
    expiresAt: new Date(Date.now() + 86400000),
  };
}
