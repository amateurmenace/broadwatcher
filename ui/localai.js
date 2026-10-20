/* The local AI guide: four short steps that get an OpenAI-compatible server (LM Studio or Ollama) answering
   Broadwatch: pick a program, install it and a model, start its server, enter the address and test. Saves
   ai.base_url / ai.model and makes the local model the active provider (POST /api/settings). */
window.LocalAI = (function () {
	const $ = (id) => document.getElementById(id)
	const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))
	const STEPS = ['Which program', 'Install and pick a model', 'Start its server', 'Connect and test']
	let onDone = null
	let step = 0
	let choice = 'lmstudio'
	let url = ''
	let model = ''
	let msg = ''

	async function open(opts = {}) {
		onDone = opts.onDone || null
		step = 0
		msg = ''
		try {
			const s = await (await fetch('/api/settings')).json()
			url = s.ai?.base_url || ''
			model = s.ai?.model || ''
		} catch {}
		$('wizardOverlay').hidden = false
		render()
	}
	function close() {
		$('wizardOverlay').hidden = true
	}
	const defaults = () => ({ url: choice === 'ollama' ? 'http://127.0.0.1:11434/v1' : 'http://127.0.0.1:1234/v1', model: choice === 'ollama' ? 'gemma3:12b' : '' })

	function body() {
		if (step === 0)
			return `<p>A local model keeps every question on this computer and costs nothing to run; it is slower and a little less sharp than Claude. Two programs serve models in the OpenAI format Broadwatch speaks:</p>
			<div class="opt">
				<label class="${choice === 'lmstudio' ? 'on' : ''}"><input type="radio" name="wizProg" value="lmstudio" ${choice === 'lmstudio' ? 'checked' : ''}><span><b>LM Studio</b> <small>recommended · a desktop app for Windows and Mac: pick a model in a catalogue, one switch starts the server. Needs a GPU with 6 GB or more for a useful model (this PC qualifies).</small></span></label>
				<label class="${choice === 'ollama' ? 'on' : ''}"><input type="radio" name="wizProg" value="ollama" ${choice === 'ollama' ? 'checked' : ''}><span><b>Ollama</b> <small>a command-line service; runs in the background from boot. Good on a Mac or a server without a screen.</small></span></label>
			</div>
			<p>Already running one of them? Jump to <a href="#" data-wiz-go="3">Connect and test</a>.</p>`
		if (step === 1)
			return choice === 'ollama'
				? `<ol>
				<li>Download Ollama from <b>ollama.com</b> and install it; it starts as a background service on port 11434.</li>
				<li>Open a terminal and pull a model: <code>ollama pull gemma3:12b</code> (about 8 GB; on a machine with less than 8 GB of GPU memory use <code>gemma3:4b</code>).</li>
				<li>Check it answers: <code>ollama run gemma3:12b "say OK"</code>.</li>
			</ol>`
				: `<ol>
				<li>Download LM Studio from <b>lmstudio.ai</b> (free) and install it.</li>
				<li>Open the <b>Discover</b> tab (the magnifying glass) and search for a model. A good first choice on this PC is <b>google/gemma-3-12b</b> (needs about 8 GB of GPU memory); with 6 GB or less take <b>google/gemma-3-4b</b>; <b>qwen/qwen3-8b</b> is a strong alternative. Click Download.</li>
				<li>When the download ends, load the model once from the <b>Chat</b> tab to make sure it runs (the model name you see there is the one Broadwatch will ask for).</li>
			</ol>`
		if (step === 2)
			return choice === 'ollama'
				? `<ol>
				<li>Ollama's server is already running on <code>http://127.0.0.1:11434</code>; nothing to start.</li>
				<li>If Broadwatch runs on another machine, set the environment variable <code>OLLAMA_HOST=0.0.0.0</code> and restart Ollama so it listens on the network.</li>
			</ol>`
				: `<ol>
				<li>In LM Studio open the <b>Developer</b> tab (the <code>&gt;_</code> icon on the left).</li>
				<li>Flip the switch at the top to <b>Running</b>. The server listens on port <b>1234</b>.</li>
				<li>Tick <b>Serve on Local Network</b> if Broadwatch runs on another computer than LM Studio; leave it off when both run here.</li>
				<li>Tick <b>Just-in-Time model loading</b> so the model loads when Broadwatch first asks.</li>
			</ol>`
		const d = defaults()
		return `<p>The address of the server and the model to ask for. Test sends one tiny question and shows the reply.</p>
			<div class="field"><span>Server URL</span><input id="wizUrl" value="${esc(url || d.url)}" placeholder="${esc(d.url)}"><small>${choice === 'ollama' ? 'Ollama answers OpenAI-style requests under /v1' : 'LM Studio: http://127.0.0.1:1234/v1 on this PC, or http://&lt;that PC&gt;:1234/v1 across the LAN'}</small></div>
			<div class="field"><span>Model</span><input id="wizModel" value="${esc(model || d.model)}" placeholder="${esc(choice === 'ollama' ? 'gemma3:12b' : 'google/gemma-3-12b (empty = whatever the server has loaded)')}"><small>${choice === 'ollama' ? 'the name you pulled' : 'the model identifier shown in LM Studio; empty lets the server choose the loaded model'}</small></div>
			<div class="row" style="display:flex;gap:10px;align-items:center;margin-top:10px"><button class="btn" id="wizTest">Test</button><span class="msg" id="wizMsg">${esc(msg)}</span></div>`
	}
	function render() {
		$('wizardEditor').innerHTML = `<header><h2>Set up a local AI</h2><small>step ${step + 1} of ${STEPS.length} · ${esc(STEPS[step])}</small></header>
		<div class="body"><div class="steps-nav">${STEPS.map((s, i) => `<span class="${i === step ? 'on' : i < step ? 'done' : ''}">${i + 1} · ${esc(s)}</span>`).join('')}</div>${body()}</div>
		<footer>${step > 0 ? '<button class="btn quiet" id="wizBack">Back</button>' : ''}${step < STEPS.length - 1 ? '<button class="btn primary" id="wizNext">Next</button>' : '<button class="btn primary" id="wizSave">Use this model</button>'}<button class="btn quiet" id="wizClose">Close</button></footer>`
	}
	function readFields() {
		if ($('wizUrl')) url = $('wizUrl').value.trim()
		if ($('wizModel')) model = $('wizModel').value.trim()
	}
	async function test() {
		readFields()
		const out = $('wizMsg')
		out.textContent = 'asking the model…'
		out.className = 'msg'
		try {
			const r = await fetch('/api/settings/test', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ section: 'ai', values: { provider: 'openai', base_url: url, ...(model ? { model } : {}) } }) })
			const j = await r.json()
			if (!j.ok) throw new Error(j.error || 'no answer')
			out.textContent = `OK · ${j.model} answered "${j.reply}" in ${(j.ms / 1000).toFixed(1)} s`
			out.className = 'msg ok'
		} catch (e) {
			out.textContent = 'failed: ' + e.message + (choice === 'lmstudio' ? ' · is the server switch on in LM Studio, and a model loaded?' : ' · is Ollama running, and the model pulled?')
			out.className = 'msg error'
		}
	}
	async function save() {
		readFields()
		if (!url) return render((msg = 'enter the server URL first'))
		try {
			const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ai: { provider: 'openai', base_url: url, model } }) })
			const j = await r.json()
			if (j.error) throw new Error(j.error)
			close()
			if (onDone) onDone(j)
		} catch (e) {
			msg = 'could not save: ' + e.message
			render()
		}
	}

	document.addEventListener('click', (e) => {
		const t = e.target
		if (!t.closest?.('#wizardEditor')) {
			if (t.id === 'wizardOverlay') close()
			return
		}
		if (t.id === 'wizClose') return close()
		if (t.id === 'wizNext') {
			readFields()
			step = Math.min(STEPS.length - 1, step + 1)
			return render()
		}
		if (t.id === 'wizBack') {
			readFields()
			step = Math.max(0, step - 1)
			return render()
		}
		if (t.id === 'wizTest') return test()
		if (t.id === 'wizSave') return save()
		const go = t.closest('[data-wiz-go]')
		if (go) {
			e.preventDefault()
			step = Number(go.getAttribute('data-wiz-go'))
			return render()
		}
	})
	document.addEventListener('change', (e) => {
		if (e.target.name === 'wizProg') {
			choice = e.target.value
			url = ''
			model = ''
			render()
		}
	})
	document.addEventListener('keydown', (e) => {
		if (e.key === 'Escape' && !$('wizardOverlay').hidden) close()
	})
	return { open, close }
})()
