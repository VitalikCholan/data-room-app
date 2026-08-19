import { DocumentBuilder } from '@nestjs/swagger'

export function buildSwagger() {
  return new DocumentBuilder()
    .setTitle('Data Room API')
    .setDescription('Owner-scoped document repository with read-only sharing')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer' }, 'access-token')
    .addApiKey(
      { type: 'apiKey', in: 'header', name: 'X-Share-Token' },
      'share-token',
    )
    .build()
}
