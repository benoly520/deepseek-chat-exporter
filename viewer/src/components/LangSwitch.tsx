/**
 * 语言切换按钮：显示的是**目标**语言（中文界面显示 EN，英文界面显示 ZH）。
 *
 * 用拉丁字母而非汉字「中」——无中文字体的系统会把汉字渲染成方框。
 */

import { lang, t, toggleLang } from '../i18n';

export function LangSwitch() {
  return (
    <button
      class="lang-switch"
      title={lang() === 'zh' ? t('lang.switchToEn') : t('lang.switchToZh')}
      onClick={toggleLang}
    >
      {lang() === 'zh' ? 'EN' : 'ZH'}
    </button>
  );
}
