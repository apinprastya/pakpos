// Package curl converts between curl command lines and model.Request.
//
// Parse reads a command copied from a terminal, browser devtools ("Copy as
// cURL") or API docs. It splits it into words like a POSIX shell (single and
// double quotes, backslash escapes, $'…' ANSI-C quoting, backslash-newline
// continuations, # comments), and also accepts Windows cmd commands (^
// escapes and continuations, as Chrome's "Copy as cURL (cmd)" writes them)
// and PowerShell backtick continuations, with a warning. Options it doesn't
// support are reported as warnings, never as errors.
//
// Generate writes a request as a multi-line POSIX shell command.
//
// The package has no Wails dependency.
package curl

import (
	"errors"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"
)

// Warning describes something in the command that was ignored or imported
// differently from what curl would do.
type Warning struct {
	// Option is the option the warning is about (e.g. "--insecure"), or "".
	Option  string `json:"option"`
	Message string `json:"message"`
}

// Errors returned by Parse.
var (
	ErrNotCurl         = errors.New("not a curl command")
	ErrUnclosedQuote   = errors.New("a quote is not closed")
	ErrMissingURL      = errors.New("the command has no URL")
	ErrMissingArgument = errors.New("an option is missing its value")
)

var cmdContinuationRe = regexp.MustCompile(`\^\r?\n`)

// isCmd reports whether text looks like a Windows cmd command: ^ line
// continuations, or ^" quoting as Chrome's "Copy as cURL (cmd)" writes it.
func isCmd(text string) bool {
	return cmdContinuationRe.MatchString(text) || strings.Contains(text, `^"`)
}

// splitResult is the words of the first command in a text.
type splitResult struct {
	words    []string
	warnings []Warning
}

// splitWords splits text into the words of its first command, choosing cmd
// or POSIX rules.
func splitWords(text string) (splitResult, error) {
	if isCmd(text) {
		words, rest := splitCmd(text)
		res := splitResult{words: words, warnings: []Warning{{
			Message: "This looks like a Windows cmd command. It was read with cmd quoting (^ escapes).",
		}}}
		if rest {
			res.warnings = append(res.warnings, onlyFirstCommand)
		}
		return res, nil
	}
	return splitPOSIX(text)
}

var onlyFirstCommand = Warning{Message: "Only the first command was imported; the rest of the text was ignored."}

// splitPOSIX splits like a POSIX shell, stopping at the first command
// separator (|, ;, &&, a redirection, or a new line that starts another
// curl command). Variables ($HOME) are kept as written. A newline without a
// continuation is treated as a space, since pasted commands are often
// wrapped.
func splitPOSIX(text string) (splitResult, error) {
	var (
		res            splitResult
		word           strings.Builder
		inWord         bool
		lineStart      = true
		backtickWarned bool
	)
	flush := func() {
		if inWord {
			res.words = append(res.words, word.String())
			word.Reset()
			inWord = false
		}
	}
	stop := func(i int) {
		if strings.TrimLeft(text[i:], "|;&<>) \t\r\n") != "" {
			res.warnings = append(res.warnings, onlyFirstCommand)
		}
	}

	for i := 0; i < len(text); {
		c := text[i]
		switch {
		case c == '\\' && i+1 < len(text) && (text[i+1] == '\n' || (text[i+1] == '\r' && i+2 < len(text) && text[i+2] == '\n')):
			// Line continuation.
			if text[i+1] == '\r' {
				i += 3
			} else {
				i += 2
			}
			continue
		case c == '`' && atLineEnd(text, i+1):
			// PowerShell continuation.
			if !backtickWarned {
				res.warnings = append(res.warnings, Warning{Message: "This looks like a PowerShell command. Backtick line breaks were joined; other PowerShell quoting may not be read correctly."})
				backtickWarned = true
			}
			i = skipLineEnd(text, i+1)
			continue
		case c == '\n' || c == '\r':
			flush()
			i++
			lineStart = true
			continue
		case c == ' ' || c == '\t':
			flush()
			i++
			continue
		}

		if !inWord {
			if lineStart && len(res.words) > 0 && startsCurl(text[i:]) {
				stop(i)
				flush()
				return res, nil
			}
			lineStart = false
			switch c {
			case '#':
				// Comment to the end of the line.
				for i < len(text) && text[i] != '\n' {
					i++
				}
				continue
			case '|', ';', '>', '<', '&', ')':
				stop(i)
				return res, nil
			}
		} else if c == '|' || (c == ';' && (i+1 == len(text) || isSpace(text[i+1]))) || (c == '&' && i+1 < len(text) && text[i+1] == '&') {
			flush()
			stop(i)
			return res, nil
		}

		inWord = true
		switch {
		case c == '\\':
			if i+1 < len(text) {
				r, n := utf8.DecodeRuneInString(text[i+1:])
				word.WriteRune(r)
				i += 1 + n
			} else {
				i++
			}
		case c == '\'':
			end := strings.IndexByte(text[i+1:], '\'')
			if end < 0 {
				return res, ErrUnclosedQuote
			}
			word.WriteString(text[i+1 : i+1+end])
			i += end + 2
		case c == '$' && i+1 < len(text) && text[i+1] == '\'':
			s, n, err := ansiC(text[i+2:])
			if err != nil {
				return res, err
			}
			word.WriteString(s)
			i += 2 + n
		case c == '"':
			s, n, err := doubleQuoted(text[i+1:])
			if err != nil {
				return res, err
			}
			word.WriteString(s)
			i += 1 + n
		default:
			word.WriteByte(c)
			i++
		}
	}
	flush()
	return res, nil
}

func isSpace(c byte) bool { return c == ' ' || c == '\t' || c == '\n' || c == '\r' }

// atLineEnd reports whether only spaces and then a line break (or the end)
// follow position i.
func atLineEnd(text string, i int) bool {
	for ; i < len(text); i++ {
		switch text[i] {
		case ' ', '\t':
		case '\r', '\n':
			return true
		default:
			return false
		}
	}
	return true
}

func skipLineEnd(text string, i int) int {
	for i < len(text) && (text[i] == ' ' || text[i] == '\t') {
		i++
	}
	if i < len(text) && text[i] == '\r' {
		i++
	}
	if i < len(text) && text[i] == '\n' {
		i++
	}
	return i
}

var curlWordRe = regexp.MustCompile(`(?i)^curl(\.exe)?(\s|$)`)

func startsCurl(s string) bool { return curlWordRe.MatchString(s) }

// doubleQuoted reads a "…" string (s starts after the opening quote). A
// backslash escapes only $ ` " \ and a newline (which is removed). It
// returns the value and how many bytes it used, including the closing quote.
func doubleQuoted(s string) (string, int, error) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch c {
		case '"':
			return b.String(), i + 1, nil
		case '\\':
			if i+1 < len(s) {
				switch s[i+1] {
				case '$', '`', '"', '\\':
					b.WriteByte(s[i+1])
					i++
					continue
				case '\n':
					i++
					continue
				}
			}
			b.WriteByte(c)
		default:
			b.WriteByte(c)
		}
	}
	return "", 0, ErrUnclosedQuote
}

// ansiC reads a $'…' string (s starts after the opening quote) with bash's
// escapes. It returns the value and how many bytes it used, including the
// closing quote.
func ansiC(s string) (string, int, error) {
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if c == '\'' {
			return b.String(), i + 1, nil
		}
		if c != '\\' || i+1 >= len(s) {
			b.WriteByte(c)
			continue
		}
		i++
		switch e := s[i]; e {
		case 'n':
			b.WriteByte('\n')
		case 't':
			b.WriteByte('\t')
		case 'r':
			b.WriteByte('\r')
		case 'a':
			b.WriteByte('\a')
		case 'b':
			b.WriteByte('\b')
		case 'e', 'E':
			b.WriteByte(0x1b)
		case 'f':
			b.WriteByte('\f')
		case 'v':
			b.WriteByte('\v')
		case '\\', '\'', '"', '?':
			b.WriteByte(e)
		case 'x':
			n := hexRun(s[i+1:], 2)
			if n == 0 {
				b.WriteString(`\x`)
				continue
			}
			v, _ := strconv.ParseUint(s[i+1:i+1+n], 16, 8)
			b.WriteByte(byte(v))
			i += n
		case 'u', 'U':
			digits := 4
			if e == 'U' {
				digits = 8
			}
			n := hexRun(s[i+1:], digits)
			if n == 0 {
				b.WriteByte('\\')
				b.WriteByte(e)
				continue
			}
			v, _ := strconv.ParseUint(s[i+1:i+1+n], 16, 32)
			b.WriteRune(rune(v)) //nolint:gosec // bitSize 32 bounds v; WriteRune replaces invalid runes
			i += n
		case 'c':
			// Control character: \cX.
			if i+1 < len(s) {
				b.WriteByte(s[i+1] & 0x1f)
				i++
			}
		default:
			if e >= '0' && e <= '7' {
				n := 1
				for n < 3 && i+n < len(s) && s[i+n] >= '0' && s[i+n] <= '7' {
					n++
				}
				v, _ := strconv.ParseUint(s[i:i+n], 8, 16)
				b.WriteByte(byte(v & 0xff)) //nolint:gosec // masked to a byte, as bash does with \0777
				i += n - 1
				continue
			}
			b.WriteByte('\\')
			b.WriteByte(e)
		}
	}
	return "", 0, ErrUnclosedQuote
}

func hexRun(s string, limit int) int {
	n := 0
	for n < limit && n < len(s) && strings.IndexByte("0123456789abcdefABCDEF", s[n]) >= 0 {
		n++
	}
	return n
}

// splitCmd splits a Windows cmd command line in two passes: cmd removes ^
// escapes and continuations (outside its own "…" quoting), then the program
// splits its arguments with the Microsoft C runtime rules (quotes group,
// backslashes escape only quotes). It stops at an unescaped & or | and
// reports whether text followed.
func splitCmd(text string) ([]string, bool) {
	var line strings.Builder
	quoted, rest := false, false
cmd:
	for i := 0; i < len(text); i++ {
		c := text[i]
		switch {
		case c == '"':
			quoted = !quoted
			line.WriteByte(c)
		case c == '^' && !quoted:
			if i+1 < len(text) {
				i++
				if text[i] == '\r' && i+1 < len(text) && text[i+1] == '\n' {
					i++
				}
				if text[i] != '\n' {
					line.WriteByte(text[i])
				}
			}
		case (c == '&' || c == '|' || c == '>' || c == '<') && !quoted:
			rest = strings.TrimSpace(text[i:]) != ""
			break cmd
		default:
			line.WriteByte(c)
		}
	}
	return splitMSVC(line.String()), rest
}

// splitMSVC splits arguments like the Microsoft C runtime: whitespace
// separates, "…" groups, 2n backslashes before a quote give n backslashes
// and a quote toggle, 2n+1 give n backslashes and a literal quote, and ""
// inside quotes is a literal quote.
func splitMSVC(s string) []string {
	var (
		words  []string
		word   strings.Builder
		inWord bool
		quoted bool
	)
	for i := 0; i < len(s); i++ {
		c := s[i]
		switch {
		case isSpace(c) && !quoted:
			if inWord {
				words = append(words, word.String())
				word.Reset()
				inWord = false
			}
		case c == '\\':
			n := 0
			for i+n < len(s) && s[i+n] == '\\' {
				n++
			}
			inWord = true
			if i+n < len(s) && s[i+n] == '"' {
				word.WriteString(strings.Repeat(`\`, n/2))
				if n%2 == 1 {
					word.WriteByte('"')
					i += n
				} else {
					i += n - 1
				}
				continue
			}
			word.WriteString(strings.Repeat(`\`, n))
			i += n - 1
		case c == '"':
			inWord = true
			if quoted && i+1 < len(s) && s[i+1] == '"' {
				word.WriteByte('"')
				i++
				continue
			}
			quoted = !quoted
		default:
			inWord = true
			word.WriteByte(c)
		}
	}
	if inWord {
		words = append(words, word.String())
	}
	return words
}
