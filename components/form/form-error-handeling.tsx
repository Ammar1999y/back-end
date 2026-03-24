import { toast } from 'sonner';

export function showFormErrors(errors: Record<string, unknown>) {
  const messages = Object.values(errors)
    .filter((v): v is string => typeof v === 'string' && v.trim() !== '')
    .slice(0, 3);

  toast.error(
    messages.length ? messages.join('\n') : 'تحقق من صحه جميع الخانات'
  );
}

export function flattenErrors(data: any, path = '', result = {}) {
  if (!data) return result;
  if (Array.isArray(data)) {
    data.forEach((item, index) => {
      flattenErrors(item, path ? `${path}.${index}` : `${index}`, result);
    });
    return result;
  }
  if (typeof data === 'object') {
    // اذا ابغى ارسل المستخدم الي موقع المدخل الي غلط فيه
    // refاخذ اول
    if (data.message) {
      result[path] = data.message;
      return result;
    }
    Object.entries(data).forEach(([key, value]) =>
      flattenErrors(value, path ? `${path}.${key}` : key, result)
    );
    return result;
  }
  return result;
}

/* 
// import { required } from "@/lib/forms/messages";
import { type FieldErrors, type UseFormSetFocus } from 'react-hook-form';
import { toast } from 'sonner';

export const ErrorsHandeling = ({
  errors,
  setFocus,
}: {
  errors: FieldErrors<any>;
  setFocus: UseFormSetFocus<any>;
}) => {
  if (!Object.keys(errors).length) return;
  const firstErrorField = errors[Object.keys(errors)[0]];
  if (!firstErrorField) return;
  let message: string | undefined;
  let path: string | undefined;
  if (Array.isArray(firstErrorField) && firstErrorField.length) {
    const arrayErrors = firstErrorField[0];
    if (arrayErrors) {
      const firstArrayIndex =
        arrayErrors[Object.keys(arrayErrors)[0] as keyof typeof arrayErrors];
      path = firstArrayIndex?.ref?.name || firstArrayIndex?.root?.ref?.name;
      message = firstArrayIndex?.message || firstArrayIndex?.root?.message;
    }
  }
  if (
    !path &&
    typeof firstErrorField === 'object' &&
    !Array.isArray(firstErrorField)
  ) {
    // @ts-ignore
    path = firstErrorField.ref?.name || firstErrorField.root?.ref?.name;
    // @ts-ignore
    message = firstErrorField.message || firstErrorField.root?.message;
  }
  toast.error(message || 'قم بتحقق من صحة جميع الحقول');
  if (!path || typeof path !== 'string') return;
  // @ts-ignore
  setFocus(path);
  const fallbackElement = document.querySelector(`[data-field="${path}"]`) || document.getElementsByName(path)[0];
  if (fallbackElement) {
    const container =
      fallbackElement.closest('.space-y-2') ||
      fallbackElement.closest('.form-field-container') ||
      fallbackElement;
    container.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
};


*/
