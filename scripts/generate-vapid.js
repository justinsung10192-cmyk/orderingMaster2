// 產生 Web Push VAPID 金鑰組
// 用法：npm run generate:vapid
import webpush from 'web-push';

const keys = webpush.generateVAPIDKeys();
console.log('把下面兩個值填入 Vercel 環境變數：');
console.log('VAPID_PUBLIC_KEY=' + keys.publicKey);
console.log('VAPID_PRIVATE_KEY=' + keys.privateKey);
