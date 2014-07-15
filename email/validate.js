// how to prepare an email:
// (double check the first call to sed, make sure it escapes 's properly)
// cat email/test.js  | sed "s/'/\\'/g" | sed 's/\=$//' | sed 's/\=3D/=/g' | sed 's/\=20/ /g' | sed "s/^/'/" | sed "s/$/' +/"


module.exports = function(context) {
  if (!context.url) {
    throw new Error("polis_err_email_params_missing");
  }
  var html = 
'<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://ww' +
'w.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd"><html xmlns="http://www' +
'.w3.org/1999/xhtml"><head>' +
'    <title></title>' +
'    <meta http-equiv="Content-Type" content="text/html; charset=utf' +
'-8">' +
'    <style type="text/css">' +
'body {' +
'  margin: 0;' +
'  padding: 0;' +
'  min-width: 100%;' +
'}' +
'table {' +
'  border-collapse: collapse;' +
'  border-spacing: 0;' +
'}' +
'td {' +
'  padding: 0;' +
'  vertical-align: top;' +
'}' +
'.spacer,' +
'.border {' +
'  font-size: 1px;' +
'  line-height: 1px;' +
'}' +
'img {' +
'  border: 0;' +
'  -ms-interpolation-mode: bicubic;' +
'}' +
'.image {' +
'  font-size: 0;' +
'  Margin-bottom: 24px;' +
'}' +
'.image img {' +
'  display: block;' +
'}' +
'.logo img {' +
'  display: block;' +
'}' +
'strong {' +
'  font-weight: bold;' +
'}' +
'h1,' +
'h2,' +
'h3,' +
'p,' +
'ol,' +
'ul,' +
'li {' +
'  Margin-top: 0;' +
'}' +
'ol,' +
'ul,' +
'li {' +
'  padding-left: 0;' +
'}' +
'.btn a {' +
'  mso-hide: all;' +
'}' +
'blockquote {' +
'  Margin-top: 0;' +
'  Margin-right: 0;' +
'  Margin-bottom: 0;' +
'  padding-right: 0;' +
'}' +
'.column-top {' +
'  font-size: 32px;' +
'  line-height: 32px;' +
'}' +
'.column-bottom {' +
'  font-size: 8px;' +
'  line-height: 8px;' +
'}' +
'.column {' +
'  text-align: left;' +
'}' +
'.contents {' +
'  width: 100%;' +
'}' +
'.padded {' +
'  padding-left: 32px;' +
'  padding-right: 32px;' +
'}' +
'.wrapper {' +
'  background-color: #fbfbfb;' +
'  width: 100%;' +
'  min-width: 620px;' +
'  -webkit-text-size-adjust: 100%;' +
'  -ms-text-size-adjust: 100%;' +
'}' +
'table.wrapper {' +
'  table-layout: fixed;' +
'}' +
'.one-col,' +
'.two-col,' +
'.three-col {' +
'  Margin-left: auto;' +
'  Margin-right: auto;' +
'  width: 600px;' +
'}' +
'.one-col p,' +
'.one-col ol,' +
'.one-col ul {' +
'  Margin-bottom: 24px;' +
'}' +
'.two-col p,' +
'.two-col ol,' +
'.two-col ul {' +
'  Margin-bottom: 23px;' +
'}' +
'.two-col .image {' +
'  Margin-bottom: 23px;' +
'}' +
'.two-col .column-bottom {' +
'  font-size: 9px;' +
'  line-height: 9px;' +
'}' +
'.two-col .column {' +
'  width: 300px;' +
'}' +
'.three-col p,' +
'.three-col ol,' +
'.three-col ul {' +
'  Margin-bottom: 21px;' +
'}' +
'.three-col .image {' +
'  Margin-bottom: 21px;' +
'}' +
'.three-col .column-bottom {' +
'  font-size: 11px;' +
'  line-height: 11px;' +
'}' +
'.three-col .column {' +
'  width: 200px;' +
'}' +
'.three-col .first .padded {' +
'  padding-left: 32px;' +
'  padding-right: 16px;' +
'}' +
'.three-col .second .padded {' +
'  padding-left: 24px;' +
'  padding-right: 24px;' +
'}' +
'.three-col .third .padded {' +
'  padding-left: 16px;' +
'  padding-right: 32px;' +
'}' +
'@media only screen and (max-width: 620px) {' +
'  [class*=wrapper] {' +
'    min-width: 318px !important;' +
'    width: 100%!important;' +
'  }' +
'  [class*=wrapper] .one-col,' +
'  [class*=wrapper] .two-col,' +
'  [class*=wrapper] .three-col {' +
'    width: 318px !important;' +
'  }' +
'  [class*=wrapper] .column {' +
'    display: block;' +
'    width: 318px !important;' +
'  }' +
'  [class*=wrapper] .padded {' +
'    padding-left: 32px !important;' +
'    padding-right: 32px !important;' +
'  }' +
'  [class*=wrapper] .full {' +
'    display: none;' +
'  }' +
'  [class*=wrapper] .image {' +
'    margin-bottom: 24px !important;' +
'  }' +
'  [class*=wrapper] .image img {' +
'    height: auto !important;' +
'    width: 100% !important;' +
'  }' +
'}' +
'.wrapper h1 {' +
'  font-weight: 700;' +
'  letter-spacing: -0.03em;' +
'  -webkit-font-smoothing: antialiased;' +
'}' +
'.wrapper h2 {' +
'  font-style: italic;' +
'  font-weight: normal;' +
'  -webkit-font-smoothing: antialiased;' +
'}' +
'.wrapper h3 {' +
'  font-weight: normal;' +
'  -webkit-font-smoothing: antialiased;' +
'}' +
'.wrapper p,' +
'.wrapper ol,' +
'.wrapper ul {' +
'  -moz-osx-font-smoothing: grayscale;' +
'}' +
'blockquote {' +
'  font-style: italic;' +
'}' +
'.one-col p,' +
'.one-col ol,' +
'.one-col ul {' +
'  -webkit-font-smoothing: antialiased;' +
'}' +
'.two-col h1 {' +
'  letter-spacing: -0.02em;' +
'}' +
'.two-col p,' +
'.two-col ol,' +
'.two-col ul {' +
'  -webkit-font-smoothing: antialiased;' +
'}' +
'.feature .one-col h1 {' +
'  font-family: Georgia, serif;' +
'  letter-spacing: 0;' +
'  font-weight: normal;' +
'}' +
'.feature .one-col h2 {' +
'  font-style: normal;' +
'  font-weight: bold;' +
'}' +
'.feature .one-col h3 {' +
'  font-style: italic;' +
'}' +
'.feature .one-col p,' +
'.feature .one-col ol,' +
'.feature .one-col ul {' +
'  -webkit-font-smoothing: antialiased;' +
'}' +
'.border {' +
'  background-color: #e9e9e9;' +
'}' +
'td.border {' +
'  width: 1px;' +
'}' +
'tr.border {' +
'  height: 1px;' +
'}' +
'tr.border td {' +
'  line-height: 1px;' +
'}' +
'.one-col,' +
'.two-col,' +
'.three-col {' +
'  background-color: #ffffff;' +
'  font-size: 14px;' +
'}' +
'.one-col,' +
'.two-col,' +
'.three-col,' +
'.preheader,' +
'.header,' +
'.footer {' +
'  Margin-left: auto;' +
'  Margin-right: auto;' +
'}' +
'.preheader {' +
'  background: #fbfbfb;' +
'}' +
'.preheader table {' +
'  width: 602px;' +
'}' +
'.preheader .title,' +
'.preheader .webversion {' +
'  padding-top: 10px;' +
'  padding-bottom: 12px;' +
'  color: #999999;' +
'  font-family: Georgia, serif;' +
'  font-size: 12px;' +
'  font-style: italic;' +
'  line-height: 21px;' +
'}' +
'.preheader .title a,' +
'.preheader .webversion a {' +
'  color: #999999;' +
'}' +
'.preheader .title a:hover,' +
'.preheader .webversion a:hover {' +
'  color: #454545 !important;' +
'}' +
'.preheader .title {' +
'  text-align: left;' +
'}' +
'.preheader .webversion {' +
'  text-align: right;' +
'  width: 177px;' +
'}' +
'.wrapper h2,' +
'.wrapper h3,' +
'.wrapper p,' +
'.wrapper ol,' +
'.wrapper ul,' +
'.wrapper .feature .one-col h1 {' +
'  font-family: Georgia, serif;' +
'}' +
'@media screen and (min-width: 0) {' +
'  .wrapper h2,' +
'  .wrapper h3,' +
'  .wrapper p,' +
'  .wrapper ol,' +
'  .wrapper ul,' +
'  .wrapper .feature .one-col h1 {' +
'    font-family: Georgia, serif !important;' +
'  }' +
'}' +
'.wrapper .one-col h1,' +
'.wrapper .two-col h1,' +
'.wrapper .three-col h1,' +
'.wrapper .feature h2,' +
'.wrapper .header .logo,' +
'.wrapper .btn a,' +
'.wrapper .footer .social .social-text {' +
'  font-family: sans-serif;' +
'}' +
'@media screen and (min-width: 0) {' +
'  .wrapper .one-col h1,' +
'  .wrapper .two-col h1,' +
'  .wrapper .three-col h1,' +
'  .wrapper .feature h2,' +
'  .wrapper .header .logo,' +
'  .wrapper .btn a,' +
'  .wrapper .footer .social .social-text {' +
'    font-family: Avenir, sans-serif !important;' +
'  }' +
'}' +
'.wrapper .header .border td {' +
'  width: 602px;' +
'}' +
'.wrapper .header .logo {' +
'  color: #41637e;' +
'  font-size: 26px;' +
'  font-weight: 700;' +
'  letter-spacing: -0.02em;' +
'  line-height: 32px;' +
'  padding: 32px 0;' +
'  text-align: center;' +
'}' +
'.wrapper .header .logo a {' +
'  text-decoration: none;' +
'}' +
'.wrapper a {' +
'  color: #41637e;' +
'  text-decoration: underline;' +
'  transition: color .2s;' +
'}' +
'.wrapper a:hover {' +
'  color: #454545 !important;' +
'}' +
'.wrapper h1 {' +
'  color: #565656;' +
'  font-size: 36px;' +
'  line-height: 42px;' +
'  Margin-bottom: 18px;' +
'}' +
'.wrapper h2 {' +
'  color: #555555;' +
'  font-size: 26px;' +
'  line-height: 32px;' +
'  Margin-bottom: 20px;' +
'}' +
'.wrapper h3 {' +
'  color: #555555;' +
'  font-size: 18px;' +
'  line-height: 22px;' +
'  Margin-bottom: 16px;' +
'}' +
'.wrapper h1 a,' +
'.wrapper h2 a,' +
'.wrapper h3 a {' +
'  text-decoration: none;' +
'}' +
'.wrapper h3 a {' +
'  color: #999999;' +
'}' +
'.wrapper p,' +
'.wrapper ol,' +
'.wrapper ul {' +
'  color: #565656;' +
'}' +
'.wrapper .gray {' +
'  background-color: #f7f7f7;' +
'}' +
'.wrapper .gray blockquote {' +
'  border-left-color: #dddddd;' +
'}' +
'blockquote {' +
'  font-size: 14px;' +
'  border-left: 2px solid #e9e9e9;' +
'  Margin-left: 0;' +
'  padding-left: 16px;' +
'}' +
'table.divider {' +
'  width: 100%;' +
'}' +
'.divider .inner {' +
'  padding-bottom: 24px;' +
'}' +
'.divider table {' +
'  background-color: #41637e;' +
'  font-size: 2px;' +
'  line-height: 2px;' +
'  width: 60px;' +
'}' +
'.image .border {' +
'  background-color: #c7c7c7;' +
'}' +
'.image-frame {' +
'  background-color: #d9d9d9;' +
'  padding: 8px;' +
'}' +
'.image-background {' +
'  background-color: #f8f8f8;' +
'  display: inline-block;' +
'}' +
'.btn {' +
'  Margin-bottom: 24px;' +
'  padding: 2px;' +
'}' +
'.btn a {' +
'  background-color: #41637e;' +
'  border: 1px solid #ffffff;' +
'  color: #ffffff !important;' +
'  display: inline-block;' +
'  font-size: 13px;' +
'  font-weight: bold;' +
'  line-height: 15px;' +
'  outline-color: #41637e;' +
'  outline-style: solid;' +
'  outline-width: 2px;' +
'  padding: 10px 30px;' +
'  text-align: center;' +
'  text-decoration: none !important;' +
'  text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);' +
'  transition: background-color 0.2s, border-color 0.2s;' +
'  -webkit-font-smoothing: antialiased;' +
'}' +
'.btn a:hover {' +
'  background-color: #454545 !important;' +
'  color: #ffffff !important;' +
'  outline-color: #454545 !important;' +
'}' +
'.one-col .column table:nth-last-child(2) td h1:last-child,' +
'.one-col .column table:nth-last-child(2) td h2:last-child,' +
'.one-col .column table:nth-last-child(2) td h3:last-child,' +
'.one-col .column table:nth-last-child(2) td p:last-child,' +
'.one-col .column table:nth-last-child(2) td ol:last-child,' +
'.one-col .column table:nth-last-child(2) td ul:last-child {' +
'  Margin-bottom: 24px;' +
'}' +
'.one-col p,' +
'.one-col ol,' +
'.one-col ul {' +
'  font-size: 16px;' +
'  line-height: 24px;' +
'}' +
'.one-col ol,' +
'.one-col ul {' +
'  Margin-left: 18px;' +
'}' +
'.two-col .column table:nth-last-child(2) td h1:last-child,' +
'.two-col .column table:nth-last-child(2) td h2:last-child,' +
'.two-col .column table:nth-last-child(2) td h3:last-child,' +
'.two-col .column table:nth-last-child(2) td p:last-child,' +
'.two-col .column table:nth-last-child(2) td ol:last-child,' +
'.two-col .column table:nth-last-child(2) td ul:last-child {' +
'  Margin-bottom: 23px;' +
'}' +
'.two-col .image-frame {' +
'  padding: 6px;' +
'}' +
'.two-col h1 {' +
'  font-size: 26px;' +
'  line-height: 32px;' +
'  Margin-bottom: 16px;' +
'}' +
'.two-col h2 {' +
'  font-size: 20px;' +
'  line-height: 26px;' +
'  Margin-bottom: 18px;' +
'}' +
'.two-col h3 {' +
'  font-size: 16px;' +
'  line-height: 20px;' +
'  Margin-bottom: 14px;' +
'}' +
'.two-col p,' +
'.two-col ol,' +
'.two-col ul {' +
'  font-size: 14px;' +
'  line-height: 23px;' +
'}' +
'.two-col ol,' +
'.two-col ul {' +
'  Margin-left: 16px;' +
'}' +
'.two-col li {' +
'  padding-left: 5px;' +
'}' +
'.two-col .divider .inner {' +
'  padding-bottom: 23px;' +
'}' +
'.two-col .btn {' +
'  Margin-bottom: 23px;' +
'}' +
'.two-col blockquote {' +
'  padding-left: 16px;' +
'}' +
'.three-col .column table:nth-last-child(2) td h1:last-child,' +
'.three-col .column table:nth-last-child(2) td h2:last-child,' +
'.three-col .column table:nth-last-child(2) td h3:last-child,' +
'.three-col .column table:nth-last-child(2) td p:last-child,' +
'.three-col .column table:nth-last-child(2) td ol:last-child,' +
'.three-col .column table:nth-last-child(2) td ul:last-child {' +
'  Margin-bottom: 21px;' +
'}' +
'.three-col .image-frame {' +
'  padding: 4px;' +
'}' +
'.three-col h1 {' +
'  font-size: 20px;' +
'  line-height: 26px;' +
'  Margin-bottom: 12px;' +
'}' +
'.three-col h2 {' +
'  font-size: 16px;' +
'  line-height: 22px;' +
'  Margin-bottom: 14px;' +
'}' +
'.three-col h3 {' +
'  font-size: 14px;' +
'  line-height: 18px;' +
'  Margin-bottom: 10px;' +
'}' +
'.three-col p,' +
'.three-col ol,' +
'.three-col ul {' +
'  font-size: 12px;' +
'  line-height: 21px;' +
'}' +
'.three-col ol,' +
'.three-col ul {' +
'  Margin-left: 14px;' +
'}' +
'.three-col li {' +
'  padding-left: 6px;' +
'}' +
'.three-col .divider .inner {' +
'  padding-bottom: 21px;' +
'}' +
'.three-col .btn {' +
'  Margin-bottom: 21px;' +
'}' +
'.three-col .btn a {' +
'  font-size: 12px;' +
'  line-height: 14px;' +
'  padding: 8px 19px;' +
'}' +
'.three-col blockquote {' +
'  padding-left: 16px;' +
'}' +
'.wrapper.feature,' +
'.wrapper.feature .one-col {' +
'  background-color: #f7f7f7;' +
'}' +
'.feature .column-top {' +
'  font-size: 36px;' +
'  line-height: 36px;' +
'}' +
'.feature .column-bottom {' +
'  font-size: 4px;' +
'  line-height: 4px;' +
'}' +
'.feature .column {' +
'  text-align: center;' +
'}' +
'.feature .image {' +
'  Margin-bottom: 32px;' +
'}' +
'.feature .one-col .column table:last-child td h1:last-child,' +
'.feature .one-col .column table:last-child td h2:last-child,' +
'.feature .one-col .column table:last-child td h3:last-child,' +
'.feature .one-col .column table:last-child td p:last-child,' +
'.feature .one-col .column table:last-child td ol:last-child,' +
'.feature .one-col .column table:last-child td ul:last-child {' +
'  Margin-bottom: 32px;' +
'}' +
'.feature .one-col h1,' +
'.feature .one-col h2,' +
'.feature .one-col h3 {' +
'  text-align: center;' +
'}' +
'.feature .one-col h1 {' +
'  font-size: 52px;' +
'  line-height: 58px;' +
'  Margin-bottom: 22px;' +
'}' +
'.feature .one-col h2 {' +
'  font-size: 42px;' +
'  line-height: 48px;' +
'  Margin-bottom: 20px;' +
'}' +
'.feature .one-col h3 {' +
'  font-size: 32px;' +
'  color: #555555;' +
'  line-height: 42px;' +
'  Margin-bottom: 20px;' +
'}' +
'.feature .one-col h3 a {' +
'  color: #555555;' +
'}' +
'.feature .one-col p,' +
'.feature .one-col ol,' +
'.feature .one-col ul {' +
'  font-size: 21px;' +
'  line-height: 32px;' +
'  Margin-bottom: 32px;' +
'}' +
'.feature .one-col p a,' +
'.feature .one-col ol a,' +
'.feature .one-col ul a {' +
'  border-bottom: 1px solid #41637e;' +
'  text-decoration: none;' +
'}' +
'.feature .one-col p {' +
'  text-align: center;' +
'}' +
'.feature .one-col ol,' +
'.feature .one-col ul {' +
'  Margin-left: 40px;' +
'  text-align: left;' +
'}' +
'.feature .one-col li {' +
'  padding-left: 3px;' +
'}' +
'.feature .one-col .btn {' +
'  Margin-bottom: 32px;' +
'  text-align: center;' +
'}' +
'.feature .one-col .divider .inner {' +
'  padding-bottom: 32px;' +
'}' +
'.feature .one-col blockquote {' +
'  border-left: none;' +
'  border-bottom: 2px solid #d9d9d9;' +
'  border-top: 2px solid #d9d9d9;' +
'  Margin-bottom: 32px;' +
'  padding-bottom: 42px;' +
'  padding-left: 0;' +
'  padding-top: 42px;' +
'  position: relative;' +
'}' +
'.feature .one-col blockquote:before,' +
'.feature .one-col blockquote:after {' +
'  content: "";' +
'  display: block;' +
'  background: -moz-linear-gradient(left, #f7f7f7 25%, #d9d9d9 25%, #d9d9d' +
'9 75%, #f7f7f7 75%);' +
'  background: -webkit-gradient(linear, left top, right top, color-stop(25' +
'%, #f7f7f7), color-stop(25%, #d9d9d9), color-stop(75%, #d9d9d9), color-st' +
'op(75%, #f7f7f7));' +
'  background: -webkit-linear-gradient(left, #f7f7f7 25%, #d9d9d9 25%, #d9' +
'd9d9 75%, #f7f7f7 75%);' +
'  background: -o-linear-gradient(left, #f7f7f7 25%, #d9d9d9 25%, #d9d9d9 ' +
'75%, #f7f7f7 75%);' +
'  background: -ms-linear-gradient(left, #f7f7f7 25%, #d9d9d9 25%, #d9d9d9' +
' 75%, #f7f7f7 75%);' +
'  background: linear-gradient(to right, #f7f7f7 25%, #d9d9d9 25%, #d9d9d9' +
' 75%, #f7f7f7 75%);' +
'  position: absolute;' +
'  height: 2px;' +
'  width: 100%;' +
'}' +
'.feature .one-col blockquote:before {' +
'  top: -2px;' +
'}' +
'.feature .one-col blockquote:after {' +
'  bottom: -2px;' +
'}' +
'.feature .one-col blockquote p,' +
'.feature .one-col blockquote ol,' +
'.feature .one-col blockquote ul {' +
'  font-size: 42px;' +
'  line-height: 48px;' +
'  Margin-bottom: 48px;' +
'}' +
'.feature .one-col blockquote p:last-child,' +
'.feature .one-col blockquote ol:last-child,' +
'.feature .one-col blockquote ul:last-child {' +
'  Margin-bottom: 0 !important;' +
'}' +
'.footer {' +
'  width: 602px;' +
'}' +
'.footer .social {' +
'  padding-top: 32px;' +
'  padding-bottom: 22px;' +
'}' +
'.footer .social .divider {' +
'  text-align: center;' +
'  padding-left: 14px;' +
'  padding-right: 14px;' +
'}' +
'.footer .social .social-text {' +
'  height: 21px;' +
'  vertical-align: middle !important;' +
'  color: #41637e;' +
'  font-size: 10px;' +
'  font-weight: bold;' +
'  letter-spacing: 0.1em;' +
'  text-decoration: none;' +
'}' +
'.footer .social .social-text a {' +
'  color: #41637e;' +
'  text-decoration: none;' +
'}' +
'.footer .address .padded {' +
'  text-align: left;' +
'}' +
'.footer .subscription .padded {' +
'  text-align: right;' +
'}' +
'.footer .padded {' +
'  color: #999999;' +
'  font-family: Georgia, serif;' +
'  font-size: 12px;' +
'  line-height: 20px;' +
'}' +
'.footer .address,' +
'.footer .subscription {' +
'  padding-top: 32px;' +
'  padding-bottom: 64px;' +
'  width: 300px;' +
'}' +
'.footer .address a,' +
'.footer .subscription a {' +
'  color: #999999;' +
'  font-weight: bold;' +
'  text-decoration: none;' +
'}' +
'.footer .address table,' +
'.footer .subscription table {' +
'  width: 100%;' +
'}' +
'.footer .subscription {' +
'  text-align: right;' +
'}' +
'@media only screen and (max-width: 620px) {' +
'  [class*=wrapper] .one-col .column:last-child table:nth-last-child(2)' +
' td h1:last-child,' +
'  [class*=wrapper] .two-col .column:last-child table:nth-last-child(2)' +
' td h1:last-child,' +
'  [class*=wrapper] .three-col .column:last-child table:nth-last-child(' +
'2) td h1:last-child,' +
'  [class*=wrapper] .one-col .column:last-child table:nth-last-child(2)' +
' td h2:last-child,' +
'  [class*=wrapper] .two-col .column:last-child table:nth-last-child(2)' +
' td h2:last-child,' +
'  [class*=wrapper] .three-col .column:last-child table:nth-last-child(' +
'2) td h2:last-child,' +
'  [class*=wrapper] .one-col .column:last-child table:nth-last-child(2)' +
' td h3:last-child,' +
'  [class*=wrapper] .two-col .column:last-child table:nth-last-child(2)' +
' td h3:last-child,' +
'  [class*=wrapper] .three-col .column:last-child table:nth-last-child(' +
'2) td h3:last-child,' +
'  [class*=wrapper] .one-col .column:last-child table:nth-last-child(2)' +
' td p:last-child,' +
'  [class*=wrapper] .two-col .column:last-child table:nth-last-child(2)' +
' td p:last-child,' +
'  [class*=wrapper] .three-col .column:last-child table:nth-last-child(' +
'2) td p:last-child,' +
'  [class*=wrapper] .one-col .column:last-child table:nth-last-child(2)' +
' td ol:last-child,' +
'  [class*=wrapper] .two-col .column:last-child table:nth-last-child(2)' +
' td ol:last-child,' +
'  [class*=wrapper] .three-col .column:last-child table:nth-last-child(' +
'2) td ol:last-child,' +
'  [class*=wrapper] .one-col .column:last-child table:nth-last-child(2)' +
' td ul:last-child,' +
'  [class*=wrapper] .two-col .column:last-child table:nth-last-child(2)' +
' td ul:last-child,' +
'  [class*=wrapper] .three-col .column:last-child table:nth-last-child(' +
'2) td ul:last-child {' +
'    Margin-bottom: 24px !important;' +
'  }' +
'  [class*=wrapper] .address,' +
'  [class*=wrapper] .subscription {' +
'    display: block;' +
'    width: 318px !important;' +
'    text-align: center !important;' +
'  }' +
'  [class*=wrapper] .address {' +
'    padding-bottom: 0 !important;' +
'  }' +
'  [class*=wrapper] .subscription {' +
'    padding-top: 0 !important;' +
'  }' +
'  [class*=wrapper] h1 {' +
'    font-size: 36px !important;' +
'    letter-spacing: -0.03em !important;' +
'    line-height: 42px !important;' +
'    Margin-bottom: 18px !important;' +
'  }' +
'  [class*=wrapper] h2 {' +
'    font-size: 26px !important;' +
'    line-height: 32px !important;' +
'    Margin-bottom: 20px !important;' +
'  }' +
'  [class*=wrapper] h3 {' +
'    font-size: 18px !important;' +
'    line-height: 22px !important;' +
'    Margin-bottom: 16px !important;' +
'  }' +
'  [class*=wrapper] p,' +
'  [class*=wrapper] ol,' +
'  [class*=wrapper] ul {' +
'    font-size: 16px !important;' +
'    letter-spacing: 0 !important;' +
'    line-height: 24px !important;' +
'    Margin-bottom: 24px !important;' +
'  }' +
'  [class*=wrapper] ol,' +
'  [class*=wrapper] ul {' +
'    Margin-left: 18px !important;' +
'  }' +
'  [class*=wrapper] li {' +
'    padding-left: 2px !important;' +
'  }' +
'  [class*=wrapper] blockquote {' +
'    padding-left: 16px !important;' +
'  }' +
'  [class*=wrapper] .two-col .column:nth-child(n + 3) {' +
'    border-top: 1px solid #e9e9e9;' +
'  }' +
'  [class*=wrapper] .btn {' +
'    margin-bottom: 24px !important;' +
'  }' +
'  [class*=wrapper] .btn a {' +
'    display: block!important;' +
'    font-size: 13px!important;' +
'    font-weight: bold!important;' +
'    line-height: 15px!important;' +
'    padding: 10px 30px!important;' +
'  }' +
'  [class*=wrapper] .column-bottom {' +
'    font-size: 8px !important;' +
'    line-height: 8px !important;' +
'  }' +
'  [class*=wrapper] .first .column-bottom,' +
'  [class*=wrapper] .three-col .second .column-bottom {' +
'    display: none;' +
'  }' +
'  [class*=wrapper] .second .column-top,' +
'  [class*=wrapper] .third .column-top {' +
'    display: none;' +
'  }' +
'  [class*=wrapper] .image-frame {' +
'    padding: 4px !important;' +
'  }' +
'  [class*=wrapper] .header .logo {' +
'    font-size: 26px !important;' +
'    line-height: 32px !important;' +
'  }' +
'  [class*=wrapper] .header .logo img {' +
'    display: inline-block !important;' +
'    max-width: 260px !important;' +
'    height: auto!important;' +
'  }' +
'  [class*=wrapper] table.border,' +
'  [class*=wrapper] .header,' +
'  [class*=wrapper] .webversion,' +
'  [class*=wrapper] .footer {' +
'    width: 320px !important;' +
'  }' +
'  [class*=wrapper] .preheader .webversion,' +
'  [class*=wrapper] .header .logo a {' +
'    text-align: center !important;' +
'  }' +
'  [class*=wrapper] .preheader table,' +
'  [class*=wrapper] .border td {' +
'    width: 318px !important;' +
'  }' +
'  [class*=wrapper] .image .border td {' +
'    width: auto !important;' +
'  }' +
'  [class*=wrapper] .title {' +
'    display: none;' +
'  }' +
'  [class*=wrapper] .footer .padded {' +
'    text-align: center!important;' +
'  }' +
'  [class*=wrapper] .footer .subscription .padded {' +
'    padding-top: 20px!important;' +
'  }' +
'  [class*=wrapper] .feature .btn {' +
'    margin-bottom: 28px !important;' +
'  }' +
'  [class*=wrapper] .feature .image {' +
'    margin-bottom: 28px !important;' +
'  }' +
'  [class*=wrapper] .feature .divider .inner {' +
'    padding-bottom: 28px!important;' +
'  }' +
'  [class*=wrapper] .feature h1 {' +
'    font-size: 42px !important;' +
'    line-height: 48px !important;' +
'    margin-bottom: 20px !important;' +
'  }' +
'  [class*=wrapper] .feature h2 {' +
'    font-size: 32px !important;' +
'    line-height: 36px !important;' +
'    margin-bottom: 18px !important;' +
'  }' +
'  [class*=wrapper] .feature h3 {' +
'    font-size: 26px !important;' +
'    line-height: 32px !important;' +
'    margin-bottom: 20px !important;' +
'  }' +
'  [class*=wrapper] .feature p,' +
'  [class*=wrapper] .feature ol,' +
'  [class*=wrapper] .feature ul {' +
'    font-size: 20px !important;' +
'    line-height: 28px !important;' +
'    margin-bottom: 28px !important;' +
'  }' +
'  [class*=wrapper] .feature blockquote {' +
'    font-size: 18px !important;' +
'    line-height: 26px !important;' +
'    margin-bottom: 28px !important;' +
'    padding-bottom: 26px !important;' +
'    padding-left: 0 !important;' +
'    padding-top: 26px !important;' +
'  }' +
'  [class*=wrapper] .feature blockquote p,' +
'  [class*=wrapper] .feature blockquote ol,' +
'  [class*=wrapper] .feature blockquote ul {' +
'    font-size: 26px !important;' +
'    line-height: 32px !important;' +
'  }' +
'  [class*=wrapper] .feature blockquote p:last-child,' +
'  [class*=wrapper] .feature blockquote ol:last-child,' +
'  [class*=wrapper] .feature blockquote ul:last-child {' +
'    margin-bottom: 0 !important;' +
'  }' +
'  [class*=wrapper] .feature .column table:last-of-type h1:last-child,' +
'  [class*=wrapper] .feature .column table:last-of-type h2:last-child,' +
'  [class*=wrapper] .feature .column table:last-of-type h3:last-child {' +
'' +
'    margin-bottom: 28px !important;' +
'  }' +
'}' +
'@media only screen and (max-width: 320px) {' +
'  [class*=wrapper] td.border {' +
'    display: none;' +
'  }' +
'  [class*=wrapper] table.border,' +
'  [class*=wrapper] .header,' +
'  [class*=wrapper] .webversion,' +
'  [class*=wrapper] .footer {' +
'    width: 318px !important;' +
'  }' +
'}' +
'</style>' +
'    <!--[if mso]>' +
'    <style>' +
'      .spacer, .border, .column-top, .column-bottom {' +
'        mso-line-height-rule: exactly;' +
'      }' +
'    </style>' +
'    <![endif]-->' +
'  </head>' +
'  <body style="margin-top: 0;margin-bottom: 0;margin-left: 0;margin-rig' +
'ht: 0;padding-top: 0;padding-bottom: 0;padding-left: 0;padding-right: 0;m' +
'in-width: 100%" bgcolor="#fbfbfb">' +
'    <center class="wrapper" style="background-color: #fbfbfb;width: 1' +
'00%;min-width: 620px;-webkit-text-size-adjust: 100%;-ms-text-size-adjust:' +
' 100%">' +
'      <table class="wrapper" style="border-collapse: collapse;border-' +
'spacing: 0;background-color: #fbfbfb;width: 100%;min-width: 620px;-webkit' +
'-text-size-adjust: 100%;-ms-text-size-adjust: 100%;table-layout: fixed">' +
'        <tbody><tr>' +
'          <td style="padding-top: 0;padding-bottom: 0;padding-left: 0;p' +
'adding-right: 0;vertical-align: top">' +
'            <center>' +
'              <table class="preheader" style="border-collapse: collap' +
'se;border-spacing: 0;Margin-left: auto;Margin-right: auto;background-colo' +
'r: #fbfbfb;background-image: none;background-attachment: scroll;backgroun' +
'd-repeat: repeat;background-position: top left">' +
'                <tbody><tr>' +
'                  <td style="padding-top: 0;padding-bottom: 0;padding-l' +
'eft: 0;padding-right: 0;vertical-align: top">' +
// '                    <table style="border-collapse: collapse;border-spac' +
// 'ing: 0;width: 602px">' +
// '                      <tbody><tr>' +
// '                        <td class="title" style="padding-top: 10px;pa' +
// 'dding-bottom: 12px;padding-left: 0;padding-right: 0;vertical-align: top;c' +
// 'olor: #999999;font-family: Georgia, serif;font-size: 12px;font-style: ita' +
// 'lic;line-height: 21px;text-align: left">Reset your password</td>' +
// '                        <td class="webversion" style="padding-top: 10' +
// 'px;padding-bottom: 12px;padding-left: 0;padding-right: 0;vertical-align: ' +
// 'top;color: #999999;font-family: Georgia, serif;font-size: 12px;font-style' +
// ': italic;line-height: 21px;text-align: right;width: 177px">' +
// '                          <span emb-translate="NoImages">No images?</sp' +
// 'an> <a style="color: #999999;text-decoration: none;transition: color .2' +
// 's;font-weight: bold" href="http://polistechnologyinc.cmail1.com/t/d-e-v' +
// 'hdilt-' +
// 'slhirikh' +
// '-y/"><span emb-translate="Web' +
// 'Version">Click here</span></a>' +
// '                        </td>' +
// '                      </tr>' +
// '                    </tbody></table>' +
'                  </td>' +
'                </tr>' +
'              </tbody></table>' +
'              <table class="header" style="border-collapse: collapse;' +
'border-spacing: 0;Margin-left: auto;Margin-right: auto">' +
'                <tbody><tr class="border" style="font-size: 1px;line-' +
'height: 1px;background-color: #e9e9e9;height: 1px"><td style="padding-t' +
'op: 0;padding-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: ' +
'top;line-height: 1px;width: 602px">&nbsp;</td></tr>' +
'                <tr><td class="logo" style="padding-top: 32px;padding' +
'-bottom: 32px;padding-left: 0;padding-right: 0;vertical-align: top;font-f' +
'amily: sans-serif;color: #41637e;font-size: 26px;font-weight: 700;letter-' +
'spacing: -0.02em;line-height: 32px;text-align: center" align="center"><' +
'center><div id="emb-email-header"><img style="border-left-width: 0;bo' +
'rder-top-width: 0;border-bottom-width: 0;border-right-width: 0;-ms-interp' +
'olation-mode: bicubic;display: block;max-width: 333px" src="http://i1.c' +
'mail1.com/ei/d/C7/3A3/32F/102809/csfinal/Screenshot2014-07-1411.53.04.png' +
'" alt="" width="222" height="90"></div></center></td></tr>' +
'              </tbody></table>' +
'            </center>' +
'          </td>' +
'        </tr>' +
'      </tbody></table>' +
'      ' +
'          <table class="wrapper feature" style="border-collapse: coll' +
'apse;border-spacing: 0;background-color: #f7f7f7;width: 100%;min-width: 6' +
'20px;-webkit-text-size-adjust: 100%;-ms-text-size-adjust: 100%;table-layo' +
'ut: fixed" width="100%">' +
'            <tbody><tr class="border" style="font-size: 1px;line-heig' +
'ht: 1px;background-color: #e9e9e9;height: 1px"><td style="padding-top: ' +
'0;padding-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;' +
'line-height: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f2f2f2;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f3f3f3;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f4f4f4;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f5f5f5;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f6f6f6;height: 2px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr>' +
'              <td style="padding-top: 0;padding-bottom: 0;padding-left:' +
' 0;padding-right: 0;vertical-align: top" align="center">' +
'                <table class="one-col" style="border-collapse: collap' +
'se;border-spacing: 0;Margin-left: auto;Margin-right: auto;width: 600px;ba' +
'ckground-color: #f7f7f7;font-size: 14px">' +
'                  <tbody><tr>' +
'                    <td class="column" style="padding-top: 0;padding-' +
'bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;text-align' +
': center">' +
'                      <div><div class="column-top" style="font-size: ' +
'36px;line-height: 36px">&nbsp;</div></div>' +
'                        <table class="contents" style="border-collaps' +
'e: collapse;border-spacing: 0;width: 100%">' +
'                          <tbody><tr>' +
'                            <td class="padded" style="padding-top: 0;' +
'padding-bottom: 0;padding-left: 32px;padding-right: 32px;vertical-align: ' +
'top">' +
'                              ' +
'            <h2 style="Margin-top: 0;font-style: normal;font-weight: bo' +
'ld;-webkit-font-smoothing: antialiased;font-family: sans-serif;color: #55' +
'5555;font-size: 42px;line-height: 48px;Margin-bottom: 20px;text-align: ce' +
'nter"><strong style="font-weight: bold">Welcome</strong></h2>' +
'          ' +
'                            </td>' +
'                          </tr>' +
'                        </tbody></table>' +
'                      ' +
'                        <table class="contents" style="border-collaps' +
'e: collapse;border-spacing: 0;width: 100%">' +
'                          <tbody><tr>' +
'                            <td class="padded" style="padding-top: 0;' +
'padding-bottom: 0;padding-left: 32px;padding-right: 32px;vertical-align: ' +
'top">' +
'                              ' +
'            <table class="divider" style="border-collapse: collapse;b' +
'order-spacing: 0;width: 100%"><tbody><tr><td class="inner" style="pad' +
'ding-top: 0;padding-bottom: 32px;padding-left: 0;padding-right: 0;vertica' +
'l-align: top" align="center">' +
'              <table style="border-collapse: collapse;border-spacing: 0' +
';background-color: #41637e;font-size: 2px;line-height: 2px;width: 60px">' +
'                <tbody><tr><td style="padding-top: 0;padding-bottom: 0;' +
'padding-left: 0;padding-right: 0;vertical-align: top">&nbsp;</td></tr>' +
'              </tbody></table>' +
'            </td></tr></tbody></table>' +
'          ' +
'                            </td>' +
'                          </tr>' +
'                        </tbody></table>' +
'                      ' +
'                        <table class="contents" style="border-collaps' +
'e: collapse;border-spacing: 0;width: 100%">' +
'                          <tbody><tr>' +
'                            <td class="padded" style="padding-top: 0;' +
'padding-bottom: 0;padding-left: 32px;padding-right: 32px;vertical-align: ' +
'top">' +
'                              ' +
'            <p style="Margin-top: 0;-moz-osx-font-smoothing: grayscale;' +
'font-family: Georgia, serif;color: #565656;Margin-bottom: 32px;-webkit-fo' +
'nt-smoothing: antialiased;font-size: 21px;line-height: 32px;text-align: c' +
'enter">We\'re excited you\'re here, and look forward to supporting you.' +
' &nbsp;Click below to get started.</p>' +
'          ' +
'                            </td>' +
'                          </tr>' +
'                        </tbody></table>' +
'                      ' +
'                        <table class="contents" style="border-collaps' +
'e: collapse;border-spacing: 0;width: 100%">' +
'                          <tbody><tr>' +
'                            <td class="padded" style="padding-top: 0;' +
'padding-bottom: 0;padding-left: 32px;padding-right: 32px;vertical-align: ' +
'top">' +
'                              ' +
'            <div class="btn" style="Margin-bottom: 32px;padding-top: ' +
'2px;padding-bottom: 2px;padding-left: 2px;padding-right: 2px;text-align: ' +
'center">' +
'              ' +
'<!--[if !mso]><!-- --><a style="mso-hide: all;background-color: #41637' +
'e;border-left-color: #ffffff;border-left-style: solid;border-left-width: ' +
'1px;border-top-color: #ffffff;border-top-style: solid;border-top-width: 1' +
'px;border-bottom-color: #ffffff;border-bottom-style: solid;border-bottom-' +
'width: 1px;border-right-color: #ffffff;border-right-style: solid;border-r' +
'ight-width: 1px;color: #ffffff !important;display: inline-block;font-size' +
': 13px;font-weight: bold;line-height: 15px;outline-color: #41637e;outline' +
'-style: solid;outline-width: 2px;padding-top: 10px;padding-bottom: 10px;p' +
'adding-left: 30px;padding-right: 30px;text-align: center;text-decoration:' +
' none !important;text-shadow: 0 1px 0 rgba(0, 0, 0, 0.3);transition: colo' +
'r .2s;-webkit-font-smoothing: antialiased;font-family: sans-serif" ' +
'href="http://polistechnologyinc.cmail1.com/t/d-l-vhdilt-' +
'' +
'slhirikh' +
'-r/">Confirm Your Email Address</a><!--<![endif]-->' +
'' +
'            <!--[if mso]><v:rect xmlns:v="urn:schemas-microsoft-com:vm' +
'l" href="http://polistechnologyinc.cmail1.com/t/d-l-vhdilt-' +
'' +
'slhirikh' +
'-r/" style="width:232px" fillcolor="#41637E" ' +
'strokecolor="#41637E" strokeweight="6px"><v:stroke linestyle="thint' +
'hin"></v:stroke><v:textbox style="mso-fit-shape-to-text:t" inset="0px' +
',7px,0px,7px"><center style="font-size:13px;line-height:15px;color:#FFF' +
'FFF;font-family:sans-serif;font-weight:bold;mso-line-height-rule:exactly;' +
'mso-text-raise:0px">Confirm Your Email Address</center></v:textbox></v:re' +
'ct><![endif]--></div>' +
'          ' +
'                            </td>' +
'                          </tr>' +
'                        </tbody></table>' +
'                      ' +
'                        <table class="contents" style="border-collaps' +
'e: collapse;border-spacing: 0;width: 100%">' +
'                          <tbody><tr>' +
'                            <td class="padded" style="padding-top: 0;' +
'padding-bottom: 0;padding-left: 32px;padding-right: 32px;vertical-align: ' +
'top">' +
'                              ' +
'            <p style="Margin-top: 0;-moz-osx-font-smoothing: grayscale;' +
'font-family: Georgia, serif;color: #565656;Margin-bottom: 32px;-webkit-fo' +
'nt-smoothing: antialiased;font-size: 21px;line-height: 32px;text-align: c' +
'enter">With gratitude,</p><p style="Margin-top: 0;-moz-osx-font-smoothi' +
'ng: grayscale;font-family: Georgia, serif;color: #565656;Margin-bottom: 3' +
'2px;-webkit-font-smoothing: antialiased;font-size: 21px;line-height: 32px' +
';text-align: center"><em>The pol.is team</em></p>' +
'          ' +
'                            </td>' +
'                          </tr>' +
'                        </tbody></table>' +
'                      ' +
'                    </td>' +
'                  </tr>' +
'                </tbody></table>' +
'                <div class="column-bottom" style="font-size: 4px;line' +
'-height: 4px">&nbsp;</div>' +
'              </td>' +
'            </tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f6f6f6;height: 2px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f5f5f5;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f4f4f4;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f3f3f3;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #f2f2f2;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'            <tr class="border" style="font-size: 1px;line-height: 1px' +
';background-color: #e9e9e9;height: 1px"><td style="padding-top: 0;paddi' +
'ng-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;line-he' +
'ight: 1px">&nbsp;</td></tr>' +
'          </tbody></table>' +
'        ' +
'      <div class="spacer" style="font-size: 1px;line-height: 32px">&n' +
'bsp;</div>' +
'      <table class="wrapper" style="border-collapse: collapse;border-' +
'spacing: 0;background-color: #fbfbfb;width: 100%;min-width: 620px;-webkit' +
'-text-size-adjust: 100%;-ms-text-size-adjust: 100%;table-layout: fixed">' +
'        <tbody><tr>' +
'          <td style="padding-top: 0;padding-bottom: 0;padding-left: 0;p' +
'adding-right: 0;vertical-align: top">' +
'            <center>' +
'              <table class="footer" style="border-collapse: collapse;' +
'border-spacing: 0;Margin-left: auto;Margin-right: auto;width: 602px">' +
'                <tbody><tr>' +
'                  <td class="social" style="padding-top: 32px;padding' +
'-bottom: 22px;padding-left: 0;padding-right: 0;vertical-align: top" align' +
'="center">' +
'                    ' +
'                  </td>' +
'                </tr>' +
'                <tr class="border" style="font-size: 1px;line-height:' +
' 1px;background-color: #e9e9e9;height: 1px"><td style="padding-top: 0;p' +
'adding-bottom: 0;padding-left: 0;padding-right: 0;vertical-align: top;lin' +
'e-height: 1px">&nbsp;</td></tr>' +
'                <tr>' +
'                  <td style="padding-top: 0;padding-bottom: 0;padding-l' +
'eft: 0;padding-right: 0;vertical-align: top">' +
'                    <table style="border-collapse: collapse;border-spac' +
'ing: 0">' +
'                      <tbody><tr>' +
'                        <td class="address" style="padding-top: 32px;' +
'padding-bottom: 64px;padding-left: 0;padding-right: 0;vertical-align: top' +
';width: 300px">' +
'                          <table class="contents" style="border-colla' +
'pse: collapse;border-spacing: 0;width: 100%">' +
'                            <tbody><tr>' +
'                              <td class="padded" style="padding-top: ' +
'0;padding-bottom: 0;padding-left: 32px;padding-right: 32px;vertical-align' +
': top;color: #999999;font-family: Georgia, serif;font-size: 12px;line-hei' +
'ght: 20px;text-align: left">' +
'                                <div>&#169;&nbsp;Polis Technology Inc., 2' +
'014</div>' +
'                              </td>' +
'                            </tr>' +
'                          </tbody></table>' +
'                        </td>' +
// '                        <td class="subscription" style="padding-top: ' +
// '32px;padding-bottom: 64px;padding-left: 0;padding-right: 0;vertical-align' +
// ': top;width: 300px;text-align: right">' +
// '                          <table class="contents" style="border-colla' +
// 'pse: collapse;border-spacing: 0;width: 100%">' +
// '                            <tbody><tr>' +
// '                              <td class="padded" style="padding-top: ' +
// '0;padding-bottom: 0;padding-left: 32px;padding-right: 32px;vertical-align' +
// ': top;color: #999999;font-family: Georgia, serif;font-size: 12px;line-hei' +
// 'ght: 20px;text-align: right">' +
// '                                <div>You are receiving this email because' +
// ' you created a new pol.is conversation.</div>' +
// '                                <div><span><a style="color: #999999;tex' +
// 't-decoration: none;transition: color .2s;font-weight: bold" href="http:' +
// '//polistechnologyinc.updatemyprofile.com/d-vhdilt-' +
// '' +
// '0B132C62-slhirikh' +
// '-j"><span emb-translate="Preferences">' +
// 'Preferences</span></a>&nbsp;&nbsp;|&nbsp;&nbsp;</span><a style="color: ' +
// '#999999;text-decoration: none;transition: color .2s;font-weight: bold" hr' +
// 'ef="http://polistechnologyinc.cmail1.com/t/d-u-vhdilt-' +
// '' +
// 'slhirikh' +
// '-h/"><span emb-translate="Unsubscribe">Unsubscribe</' +
// 'span></a></div>' +
// '                              </td>' +
// '                            </tr>' +
// '                          </tbody></table>' +
// '                        </td>' +
'                      </tr>' +
'                    </tbody></table>' +
'                  </td>' +
'                </tr>' +
'              </tbody></table>' +
'            </center>' +
'          </td>' +
'        </tr>' +
'      </tbody></table>' +
'    </center>' +
// '  <img style="border-left-width: 0 !important;border-top-width: 0 !impo' +
// 'rtant;border-bottom-width: 0 !important;border-right-width: 0 !important;' +
// '-ms-interpolation-mode: bicubic;height: 1px !important;width: 1px !import' +
// 'ant;margin-top: 0 !important;margin-bottom: 0 !important;margin-left: 0 !' +
// 'important;margin-right: 0 !important;padding-top: 0 !important;padding-bo' +
// 'ttom: 0 !important;padding-left: 0 !important;padding-right: 0 !important' +
// '" src="https://cmail1.com/t/d-o-vhdilt-' +
// 'slhirikh' +
// '/o.gif" width="1" height="1" border="0" alt="">' +
'</body></html>' +
'' +
'' +
'' +
'' +
'--_=aspNetEmail=_889d387b5dfb4a9489a33c1c62dbc7e6--' +
'Todoist' +
'';

  return html;
}