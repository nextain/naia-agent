export type Locale =
  | "ko"
  | "en"
  | "ja"
  | "zh"
  | "fr"
  | "de"
  | "ru"
  | "es"
  | "ar"
  | "hi"
  | "bn"
  | "pt"
  | "id"
  | "vi";

export type TranslationKey =
  | "cli.no_provider"
  | "cli.no_provider_hint"
  | "cli.login_usage"
  | "cli.unknown_flag"
  | "cli.empty_prompt"
  | "cli.session_started"
  | "cli.session_ended"
  | "wizard.welcome"
  | "wizard.language_prompt"
  | "wizard.key_prompt"
  | "wizard.model_prompt"
  | "wizard.embedding_prompt"
  | "wizard.persona_prompt"
  | "wizard.done"
  | "error.generic"
  | "error.timeout"
  | "error.tool_not_found"
  | "skill.time.description"
  | "skill.weather.description"
  | "skill.memo.description"
  | "skill.system_status.description";

const translations: Record<TranslationKey, Record<Locale, string>> = {
  "cli.no_provider": {
    ko: "LLM 프로바이더가 설정되지 않았습니다.",
    en: "No LLM provider configured.",
    ja: "LLMプロバイダーが設定されていません。", zh: "未配置LLM提供商。", fr: "Aucun fournisseur LLM configuré.", de: "Kein LLM-Anbieter konfiguriert.", ru: "Провайдер LLM не настроен.", es: "No hay proveedor LLM configurado.", ar: "لم يتم تكوين مزود LLM.", hi: "कोई LLM प्रदाता कॉन्फ़िगर नहीं किया गया।", bn: "কোনো LLM প্রদানকারী কনফিগার করা হয়নি।", pt: "Nenhum provedor LLM configurado.", id: "Tidak ada penyedia LLM yang dikonfigurasi.", vi: "Chưa cấu hình nhà cung cấp LLM.",
  },
  "cli.no_provider_hint": {
    ko: "naia-agent login --key <provider> 또는 ANTHROPIC_API_KEY 환경변수를 설정하세요.",
    en: "Run `naia-agent login --key <provider>` or set ANTHROPIC_API_KEY env.",
    ja: "`naia-agent login --key <provider>`を実行するか、ANTHROPIC_API_KEY環境変数を設定してください。", zh: "运行`naia-agent login --key <provider>`或设置ANTHROPIC_API_KEY环境变量。", fr: "Exécutez `naia-agent login --key <provider>` ou définissez ANTHROPIC_API_KEY.", de: "Führen Sie `naia-agent login --key <provider>` aus oder setzen Sie ANTHROPIC_API_KEY.", ru: "Выполните `naia-agent login --key <provider>` или задайте ANTHROPIC_API_KEY.", es: "Ejecute `naia-agent login --key <provider>` o configure ANTHROPIC_API_KEY.", ar: "قم بتشغيل `naia-agent login --key <provider>` أو قم بتعيين ANTHROPIC_API_KEY.", hi: "`naia-agent login --key <provider>` चलाएं या ANTHROPIC_API_KEY env सेट करें।", bn: "`naia-agent login --key <provider>` চালান বা ANTHROPIC_API_KEY env সেট করুন।", pt: "Execute `naia-agent login --key <provider>` ou defina ANTHROPIC_API_KEY.", id: "Jalankan `naia-agent login --key <provider>` atau atur ANTHROPIC_API_KEY.", vi: "Chạy `naia-agent login --key <provider>` hoặc đặt ANTHROPIC_API_KEY.",
  },
  "cli.login_usage": {
    ko: "사용법: naia-agent login --key <anthropic|openai|glm|vertex>",
    en: "Usage: naia-agent login --key <anthropic|openai|glm|vertex>",
    ja: "使用方法: naia-agent login --key <anthropic|openai|glm|vertex>", zh: "用法: naia-agent login --key <anthropic|openai|glm|vertex>", fr: "Usage: naia-agent login --key <anthropic|openai|glm|vertex>", de: "Verwendung: naia-agent login --key <anthropic|openai|glm|vertex>", ru: "Использование: naia-agent login --key <anthropic|openai|glm|vertex>", es: "Uso: naia-agent login --key <anthropic|openai|glm|vertex>", ar: "الاستخدام: naia-agent login --key <anthropic|openai|glm|vertex>", hi: "उपयोग: naia-agent login --key <anthropic|openai|glm|vertex>", bn: "ব্যবহার: naia-agent login --key <anthropic|openai|glm|vertex>", pt: "Uso: naia-agent login --key <anthropic|openai|glm|vertex>", id: "Penggunaan: naia-agent login --key <anthropic|openai|glm|vertex>", vi: "Cách dùng: naia-agent login --key <anthropic|openai|glm|vertex>",
  },
  "cli.unknown_flag": {
    ko: "알 수 없는 플래그입니다.",
    en: "Unknown flag.",
    ja: "不明なフラグです。", zh: "未知标志。", fr: "Flag inconnu.", de: "Unbekanntes Flag.", ru: "Неизвестный флаг.", es: "Flag desconocido.", ar: "علامة غير معروفة.", hi: "अज्ञात फ्लैग।", bn: "অজানা ফ্ল্যাগ।", pt: "Flag desconhecido.", id: "Flag tidak dikenal.", vi: "Flag không xác định.",
  },
  "cli.empty_prompt": {
    ko: "프롬프트가 비어있습니다.",
    en: "Empty prompt.",
    ja: "プロンプトが空です。", zh: "提示为空。", fr: "Prompt vide.", de: "Leerer Prompt.", ru: "Пустой промпт.", es: "Prompt vacío.", ar: "موجه فارغ.", hi: "रिक्त प्रॉम्प्ट।", bn: "খালি প্রম্পট।", pt: "Prompt vazio.", id: "Prompt kosong.", vi: "Prompt trống.",
  },
  "cli.session_started": {
    ko: "세션 시작",
    en: "Session started",
    ja: "セッション開始", zh: "会话已开始", fr: "Session démarrée", de: "Sitzung gestartet", ru: "Сессия начата", es: "Sesión iniciada", ar: "بدء الجلسة", hi: "सत्र शुरू", bn: "সেশন শুরু", pt: "Sessão iniciada", id: "Sesi dimulai", vi: "Phiên đã bắt đầu",
  },
  "cli.session_ended": {
    ko: "세션 종료",
    en: "Session ended",
    ja: "セッション終了", zh: "会话已结束", fr: "Session terminée", de: "Sitzung beendet", ru: "Сессия завершена", es: "Sesión finalizada", ar: "انتهت الجلسة", hi: "सत्र समाप्त", bn: "সেশন শেষ", pt: "Sessão encerrada", id: "Sesi berakhir", vi: "Phiên đã kết thúc",
  },
  "wizard.welcome": {
    ko: "Naia 에이전트에 오신 것을 환영합니다!",
    en: "Welcome to Naia Agent!",
    ja: "Naiaエージェントへようこそ！", zh: "欢迎使用Naia Agent！", fr: "Bienvenue dans Naia Agent !", de: "Willkommen bei Naia Agent!", ru: "Добро пожаловать в Naia Agent!", es: "¡Bienvenido a Naia Agent!", ar: "مرحبًا بك في Naia Agent!", hi: "Naia Agent में आपका स्वागत है!", bn: "Naia Agent-এ স্বাগতম!", pt: "Bem-vindo ao Naia Agent!", id: "Selamat datang di Naia Agent!", vi: "Chào mừng đến với Naia Agent!",
  },
  "wizard.language_prompt": {
    ko: "언어를 선택하세요",
    en: "Select language",
    ja: "言語を選択", zh: "选择语言", fr: "Choisir la langue", de: "Sprache wählen", ru: "Выберите язык", es: "Seleccionar idioma", ar: "اختر اللغة", hi: "भाषा चुनें", bn: "ভাষা নির্বাচন করুন", pt: "Selecionar idioma", id: "Pilih bahasa", vi: "Chọn ngôn ngữ",
  },
  "wizard.key_prompt": {
    ko: "API 키를 입력하세요",
    en: "Enter API key",
    ja: "APIキーを入力", zh: "输入API密钥", fr: "Entrez la clé API", de: "API-Schlüssel eingeben", ru: "Введите API-ключ", es: "Ingrese la clave API", ar: "أدخل مفتاح API", hi: "API कुंजी दर्ज करें", bn: "API কী লিখুন", pt: "Insira a chave API", id: "Masukkan kunci API", vi: "Nhập khóa API",
  },
  "wizard.model_prompt": {
    ko: "메인 모델을 선택하세요",
    en: "Select main model",
    ja: "メインモデルを選択", zh: "选择主模型", fr: "Choisir le modèle principal", de: "Hauptmodell wählen", ru: "Выберите основную модель", es: "Seleccionar modelo principal", ar: "اختر النموذج الرئيسي", hi: "मुख्य मॉडल चुनें", bn: "প্রধান মডেল নির্বাচন করুন", pt: "Selecionar modelo principal", id: "Pilih model utama", vi: "Chọn mô hình chính",
  },
  "wizard.embedding_prompt": {
    ko: "임베딩 모델을 선택하세요",
    en: "Select embedding model",
    ja: "埋め込みモデルを選択", zh: "选择嵌入模型", fr: "Choisir le modèle d'embedding", de: "Embedding-Modell wählen", ru: "Выберите модель эмбеддинга", es: "Seleccionar modelo de embedding", ar: "اختر نموذج التضمين", hi: "एम्बेडिंग मॉडल चुनें", bn: "এম্বেডিং মডেল নির্বাচন করুন", pt: "Selecionar modelo de embedding", id: "Pilih model embedding", vi: "Chọn mô hình embedding",
  },
  "wizard.persona_prompt": {
    ko: "페르소나를 입력하세요",
    en: "Enter persona",
    ja: "ペルソナを入力", zh: "输入角色", fr: "Entrez le persona", de: "Persona eingeben", ru: "Введите персону", es: "Ingrese el persona", ar: "أدخل الشخصية", hi: "पर्सोना दर्ज करें", bn: "পারসোনা লিখুন", pt: "Insira o persona", id: "Masukkan persona", vi: "Nhập persona",
  },
  "wizard.done": {
    ko: "설정이 완료되었습니다!",
    en: "Setup complete!",
    ja: "設定が完了しました！", zh: "设置完成！", fr: "Configuration terminée !", de: "Einrichtung abgeschlossen!", ru: "Настройка завершена!", es: "¡Configuración completa!", ar: "اكتمل الإعداد!", hi: "सेटअप पूरा हुआ!", bn: "সেটআপ সম্পন্ন!", pt: "Configuração concluída!", id: "Pengaturan selesai!", vi: "Cài đặt hoàn tất!",
  },
  "error.generic": {
    ko: "오류가 발생했습니다.",
    en: "An error occurred.",
    ja: "エラーが発生しました。", zh: "发生错误。", fr: "Une erreur s'est produite.", de: "Ein Fehler ist aufgetreten.", ru: "Произошла ошибка.", es: "Ocurrió un error.", ar: "حدث خطأ.", hi: "एक त्रुटि हुई।", bn: "একটি ত্রুটি ঘটেছে।", pt: "Ocorreu um erro.", id: "Terjadi kesalahan.", vi: "Đã xảy ra lỗi.",
  },
  "error.timeout": {
    ko: "요청 시간이 초과되었습니다.",
    en: "Request timed out.",
    ja: "リクエストがタイムアウトしました。", zh: "请求超时。", fr: "Délai d'attente dépassé.", de: "Zeitüberschreitung.", ru: "Тайм-аут запроса.", es: "Tiempo de espera agotado.", ar: "انتهت مهلة الطلب.", hi: "अनुरोध का समय समाप्त हो गया।", bn: "অনুরোধের সময় শেষ হয়ে গেছে।", pt: "Tempo limite atingido.", id: "Waktu habis.", vi: "Hết thời gian chờ.",
  },
  "error.tool_not_found": {
    ko: "도구를 찾을 수 없습니다.",
    en: "Tool not found.",
    ja: "ツールが見つかりません。", zh: "未找到工具。", fr: "Outil introuvable.", de: "Tool nicht gefunden.", ru: "Инструмент не найден.", es: "Herramienta no encontrada.", ar: "الأداة غير موجودة.", hi: "टूल नहीं मिला।", bn: "টুল খুঁজে পাওয়া যায়নি।", pt: "Ferramenta não encontrada.", id: "Tool tidak ditemukan.", vi: "Không tìm thấy tool.",
  },
  "skill.time.description": {
    ko: "현재 날짜와 시간을 확인합니다.",
    en: "Get the current date and time.",
    ja: "現在の日時を確認します。", zh: "获取当前日期和时间。", fr: "Obtenir la date et l'heure actuelles.", de: "Aktuelles Datum und Uhrzeit abrufen.", ru: "Получить текущую дату и время.", es: "Obtener la fecha y hora actuales.", ar: "الحصول على التاريخ والوقت الحاليين.", hi: "वर्तमान दिनांक और समय प्राप्त करें।", bn: "বর্তমান তারিখ এবং সময় পান।", pt: "Obter data e hora atuais.", id: "Dapatkan tanggal dan waktu saat ini.", vi: "Lấy ngày giờ hiện tại.",
  },
  "skill.weather.description": {
    ko: "지역의 현재 날씨를 확인합니다.",
    en: "Get current weather for a location.",
    ja: "地域の現在の天気を確認します。", zh: "获取某地的当前天气。", fr: "Obtenir la météo actuelle d'un lieu.", de: "Aktuelles Wetter für einen Ort abrufen.", ru: "Получить текущую погоду для локации.", es: "Obtener el clima actual de una ubicación.", ar: "الحصول على الطقس الحالي لموقع ما.", hi: "किसी स्थान का वर्तमान मौसम प्राप्त करें।", bn: "একটি অবস্থানের বর্তমান আবহাওয়া পান।", pt: "Obter clima atual de uma localização.", id: "Dapatkan cuaca saat ini untuk lokasi.", vi: "Lấy thời tiết hiện tại cho một địa điểm.",
  },
  "skill.memo.description": {
    ko: "간단한 메모를 저장하고 읽습니다.",
    en: "Save and read simple memos.",
    ja: "シンプルなメモを保存・読み込みします。", zh: "保存和读取简单备忘录。", fr: "Sauvegarder et lire des mémos simples.", de: "Einfache Memos speichern und lesen.", ru: "Сохранять и читать простые заметки.", es: "Guardar y leer notas simples.", ar: "حفظ وقراءة المذكرات البسيطة.", hi: "सरल मेमो सहेजें और पढ़ें।", bn: "সহজ মেমো সংরক্ষণ এবং পড়ুন।", pt: "Salvar e ler memos simples.", id: "Simpan dan baca memo sederhana.", vi: "Lưu và đọc memo đơn giản.",
  },
  "skill.system_status.description": {
    ko: "시스템 정보를 확인합니다.",
    en: "Get system information.",
    ja: "システム情報を確認します。", zh: "获取系统信息。", fr: "Obtenir les informations système.", de: "Systeminformationen abrufen.", ru: "Получить системную информацию.", es: "Obtener información del sistema.", ar: "الحصول على معلومات النظام.", hi: "सिस्टम जानकारी प्राप्त करें।", bn: "সিস্টেম তথ্য পান।", pt: "Obter informações do sistema.", id: "Dapatkan informasi sistem.", vi: "Lấy thông tin hệ thống.",
  },
};

const LOCALE_KEYS = new Set<string>([
  "ko", "en", "ja", "zh", "fr", "de", "ru", "es", "ar", "hi", "bn", "pt", "id", "vi",
]);

function normalizeLocale(raw: string | undefined): Locale {
  if (!raw) return "en";
  const lower = raw.toLowerCase().replace(/_.*$/, "");
  const short = lower.slice(0, 2);
  if (LOCALE_KEYS.has(short)) return short as Locale;
  return "en";
}

let _cachedLocale: Locale | undefined;

export function setLocale(locale: Locale): void {
  _cachedLocale = locale;
}

export function getLocale(): Locale {
  if (_cachedLocale) return _cachedLocale;
  const fromEnv =
    process.env["NAIA_AGENT_LOCALE"] ??
    process.env["LC_ALL"] ??
    process.env["LANG"];
  _cachedLocale = normalizeLocale(fromEnv);
  return _cachedLocale;
}

export function t(key: TranslationKey, locale?: Locale): string {
  const loc = locale ?? getLocale();
  const entry = translations[key];
  if (!entry) return key;
  return entry[loc] ?? entry["en"] ?? key;
}
