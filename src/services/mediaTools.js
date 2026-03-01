export const MEDIA_TOOL_DECLARATIONS = [
  {
    name: 'generateImage',
    description:
      'Generate an image from a text prompt. If an anchor image is available in the chat context, use it as a visual reference.',
    parameters: {
      type: 'OBJECT',
      properties: {
        prompt: {
          type: 'STRING',
          description:
            'Detailed image generation prompt describing subject, style, composition, colors, and mood.',
        },
      },
      required: ['prompt'],
    },
  },
];
