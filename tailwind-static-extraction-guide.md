# دليل استخراج Tailwind Classes من Rich Text Editor

## السؤال

في مشكلة معايا عند تحويل محتوى rich text editor الى html وهي انه في التصميم يتم
استخدام tailwind.

الملفات الموجودة في المجلد `components/editor/ui/static/` تحتوي على مكونات React
مع Tailwind classes.

**المشكلة:** عند تحويل المحتوى إلى HTML، يجب إرفاق ملف CSS الكامل الخاص بـ
Tailwind، وهذا يجعل حجم الملف كبير جداً.

**المطلوب:** استخراج فقط الـ Tailwind classes المستخدمة في ملفات static
components فقط.

---

## الحلول المقترحة

### الحل 1: إنشاء Tailwind Build منفصل للمكونات الثابتة (الموصى به) ⭐

هذا الحل يقوم بإنشاء ملف CSS منفصل يحتوي فقط على الـ classes المستخدمة في static
components.

#### الخطوة 1: إنشاء Tailwind Config منفصل

أنشئ ملف `tailwind.static.config.ts` في الجذر:

```typescript
import type { Config } from 'tailwindcss';

import baseConfig from './tailwind.config';

const config: Config = {
  ...baseConfig,
  content: [
    './components/editor/ui/static/**/*.{ts,tsx}',
    './lib/utils.ts', // للـ cn() function
  ],
};

export default config;
```

#### الخطوة 2: إضافة Build Script

في `package.json`:

```json
{
  "scripts": {
    "build:static-css": "tailwindcss -c tailwind.static.config.ts -o public/editor-static.css --minify"
  }
}
```

#### الخطوة 3: تشغيل البناء

```bash
npm run build:static-css
```

#### الخطوة 4: استخدام CSS المُنشأ

عند تحويل المحتوى إلى HTML، قم بإضافة:

```html
<link rel="stylesheet" href="/editor-static.css" />
```

**المميزات:**

- ✅ أصغر حجم ملف CSS
- ✅ يحتوي فقط على الـ classes المستخدمة فعلياً
- ✅ سهل الصيانة
- ✅ يعمل مع الـ Custom Tailwind Config (CSS variables, spacing, etc.)
- ✅ يمكن حفظه في الـ cache

---

### الحل 2: استخدام Tailwind CLI مع Content Scanning

استخدم Tailwind CLI مباشرة لبناء CSS من ملفات محددة:

```bash
npx tailwindcss -c tailwind.config.ts \
  -i styles/globals.css \
  -o output/editor-static.css \
  --content "components/editor/ui/static/**/*.{ts,tsx}" \
  --minify
```

**الاستخدام:** يمكنك إضافة هذا كـ script في `package.json`:

```json
{
  "scripts": {
    "build:editor-css": "tailwindcss -c tailwind.config.ts -i styles/globals.css -o public/editor-static.css --content \"components/editor/ui/static/**/*.{ts,tsx}\" --minify"
  }
}
```

---

### الحل 3: استخراج Classes برمجياً

إنشاء سكريبت Node.js لاستخراج جميع Tailwind classes من ملفات static:

#### إنشاء `scripts/extract-editor-classes.js`

```javascript
const fs = require('fs');
const path = require('path');
const glob = require('glob');

const staticDir = 'components/editor/ui/static';
const files = glob.sync(`${staticDir}/**/*.{ts,tsx}`);

// Regex للبحث عن className
const classRegex =
  /className[=:]\s*{?['"`]([^'"`]+)['"`]|className={cn\(['"`]([^'"`]+)['"`]/g;
const allClasses = new Set();

files.forEach((file) => {
  const content = fs.readFileSync(file, 'utf-8');
  let match;

  while ((match = classRegex.exec(content)) !== null) {
    const classes = (match[1] || match[2] || '').split(/\s+/);
    classes.forEach((cls) => {
      if (cls && !cls.includes('${') && !cls.includes('{')) {
        allClasses.add(cls);
      }
    });
  }
});

console.log('Extracted classes:', Array.from(allClasses).sort());

// إنشاء safelist لـ Tailwind config
const safelist = Array.from(allClasses)
  .map((cls) => `'${cls}'`)
  .join(',\n  ');
console.log('\nSafelist for tailwind.config.ts:');
console.log(`safelist: [\n  ${safelist}\n]`);
```

#### التشغيل:

```bash
node scripts/extract-editor-classes.js
```

---

### الحل 4: استخدام PurgeCSS

PurgeCSS يقوم بإزالة CSS غير المستخدم بدقة عالية.

#### التثبيت:

```bash
npm install -D @fullhuman/postcss-purgecss
```

#### إنشاء `purgecss.config.js`

```javascript
module.exports = {
  content: ['./components/editor/ui/static/**/*.{ts,tsx}'],
  css: ['.next/static/css/**/*.css'], // الـ CSS المبني
  output: './public/editor-static-purged.css',
  safelist: {
    standard: [/^slate-/, /^plate-/], // الحفاظ على الـ dynamic classes
    deep: [/data-/, /aria-/],
  },
};
```

#### التشغيل:

```bash
npx purgecss --config purgecss.config.js
```

---

### الحل 5: تحويل إلى Inline Styles (للإيميلات)

إذا كنت تريد إرسال HTML عبر البريد الإلكتروني، يمكن تحويل Tailwind classes إلى
inline styles.

#### التثبيت:

```bash
npm install -D juice
```

#### إنشاء Utility Function:

```typescript
import fs from 'fs';
import path from 'path';

import juice from 'juice';

export function convertToInlineStyles(html: string): string {
  // قراءة ملف CSS المُنشأ
  const css = fs.readFileSync(
    path.join(process.cwd(), 'public/editor-static.css'),
    'utf-8'
  );

  // تحويل CSS إلى inline styles
  return juice.inlineContent(html, css, {
    inlinePseudoElements: true,
    preserveMediaQueries: false,
  });
}
```

#### الاستخدام:

```typescript
const html = '<div class="text-2xl font-bold">Hello</div>';
const inlineHtml = convertToInlineStyles(html);
// النتيجة: <div style="font-size: 1.5rem; font-weight: 700;">Hello</div>
```

---

### الحل 6: استخدام CDN Tailwind مع JIT

استخدام Tailwind CDN مع JIT mode لتوليد CSS ديناميكياً:

```html
<script src="https://cdn.tailwindcss.com"></script>
<script>
  tailwind.config = {
    // نفس الـ config الخاص بك
    theme: {
      extend: {
        colors: {
          primary: 'hsl(var(--primary))',
        },
      },
    },
  };
</script>
```

**ملاحظة:** هذا الحل غير موصى به للـ production لأن حجم CDN كبير.

---

## المقارنة بين الحلول

| الحل              | حجم الملف            | سهولة التطبيق       | الأداء           | الاستخدام المثالي      |
| ----------------- | -------------------- | ------------------- | ---------------- | ---------------------- |
| **Build منفصل**   | ⭐⭐⭐⭐⭐ صغير جداً | ⭐⭐⭐⭐⭐ سهل      | ⭐⭐⭐⭐⭐ ممتاز | للـ Static HTML        |
| **Tailwind CLI**  | ⭐⭐⭐⭐ صغير        | ⭐⭐⭐⭐ سهل        | ⭐⭐⭐⭐⭐ ممتاز | للـ Static HTML        |
| **استخراج برمجي** | ⭐⭐⭐ متوسط         | ⭐⭐⭐ متوسط        | ⭐⭐⭐⭐ جيد     | للتحليل والـ Debugging |
| **PurgeCSS**      | ⭐⭐⭐⭐⭐ أصغر      | ⭐⭐⭐ متوسط        | ⭐⭐⭐⭐⭐ ممتاز | للتحسين الدقيق         |
| **Inline Styles** | ⭐⭐ كبير            | ⭐⭐ صعب            | ⭐⭐⭐ جيد       | للإيميلات فقط          |
| **CDN**           | ⭐ كبير جداً         | ⭐⭐⭐⭐⭐ سهل جداً | ⭐ سيء           | للـ Prototyping فقط    |

---

## التوصية النهائية

**استخدم الحل 1 (Build منفصل)** لأنه:

1. ✅ أصغر حجم ملف CSS
2. ✅ يحتوي فقط على الـ classes المستخدمة فعلياً
3. ✅ سهل الصيانة والتحديث
4. ✅ يعمل مع Custom Tailwind Config الخاص بك (CSS variables, spacing, colors)
5. ✅ يمكن حفظه في الـ cache وتحسين الأداء
6. ✅ متوافق مع CSS Modules المستخدمة في المشروع

---

## خطوات التطبيق السريع

1. **إنشاء Config منفصل:**

   ```bash
   # إنشاء tailwind.static.config.ts
   ```

2. **إضافة Build Script:**

   ```json
   "build:static-css": "tailwindcss -c tailwind.static.config.ts -o public/editor-static.css --minify"
   ```

3. **بناء CSS:**

   ```bash
   npm run build:static-css
   ```

4. **استخدام في HTML:**
   ```html
   <link rel="stylesheet" href="/editor-static.css" />
   <div class="text-2xl font-bold">محتوى من Editor</div>
   ```

---

## ملاحظات إضافية

### التعامل مع CSS Variables

المشروع يستخدم CSS variables (مثل `hsl(var(--primary))`). يجب التأكد من تضمين
هذه المتغيرات:

```css
:root {
  --primary: 222.2 47.4% 11.2%;
  --background: 0 0% 100%;
  /* ... باقي المتغيرات */
}
```

### التعامل مع Dynamic Classes

بعض الـ classes قد تكون dynamic (مثل `bg-${color}`). للحفاظ عليها:

```typescript
// في tailwind.static.config.ts
const config: Config = {
  safelist: [
    'bg-primary',
    'bg-secondary',
    'text-primary',
    // ... أضف الـ dynamic classes المستخدمة
  ],
  // ...
};
```

### CSS Modules

المشروع يستخدم CSS Modules في بعض الأماكن (مثل `editor-elements.module.css`).
تأكد من تضمينها:

```typescript
// في tailwind.static.config.ts
const config: Config = {
  content: [
    './components/editor/ui/static/**/*.{ts,tsx}',
    './components/editor/ui/**/*.module.css',
    './lib/utils.ts',
  ],
};
```

---

## Resources

- [Tailwind CSS Documentation](https://tailwindcss.com/docs)
- [PurgeCSS Documentation](https://purgecss.com/)
- [Tailwind CSS Configuration](https://tailwindcss.com/docs/configuration)
